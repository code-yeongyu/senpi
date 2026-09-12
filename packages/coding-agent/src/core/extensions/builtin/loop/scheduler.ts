/**
 * Pure state machine behind the `/loop` extension.
 *
 * Everything time-related or timer-related is injected: a {@link LoopClock} supplies
 * `now`, and a {@link LoopTimerPort} owns the single armed timeout per loop. This module
 * performs NO I/O, never calls `setTimeout`/`Date.now`, and never persists anything
 * itself — the caller mirrors {@link LoopScheduler.getState} into the sidecar store. That
 * keeps every invariant below testable with a fake clock and zero real waiting.
 *
 * The load-bearing invariants:
 * - At most ONE queued or running tick per loop. A fire that lands while one is in flight
 *   sets `coalescedFirePending` instead of enqueuing a second delivery, so a sleeping
 *   laptop or a long turn can never produce a tick storm.
 * - `nextFireAt` is ALWAYS recomputed from `now`, never from the stale due time, so all
 *   occurrences missed during sleep collapse into exactly one catch-up tick.
 * - 7-day expiry from `createdAt` is checked at arm, fire, re-entry and restore, is never
 *   extended by a new wakeup, and no tick fires at or after it.
 * - At most {@link MAX_ACTIVE_LOOPS} active loops; a further creation returns a typed
 *   rejection and leaves existing loops armed.
 * - A dispatched-tick budget (default {@link DEFAULT_MAX_TICKS}) ends the loop with
 *   `tick_budget_exhausted` so a forgotten fast loop cannot spend without bound.
 * - Keepalive is a two-strike device on dynamic loops only, and a user abort PAUSES a
 *   loop instead of ending it (and is never counted as a keepalive omission).
 * - Shutdown SUSPENDS: every senpi shutdown reason leaves the session resumable, so there
 *   is deliberately no `session_closed` terminal reason.
 * - A provider/turn error is never terminal.
 */

import type {
	CronEntry,
	DeliveryId,
	DynamicCronEntry,
	EffectiveInterval,
	EpochMs,
	FixedCronEntry,
	LoopEndReason,
	LoopEntryFields,
	LoopId,
	LoopPayload,
	LoopState,
	PendingWakeup,
	RequestedInterval,
	WakeupId,
} from "./types.ts";
import { LOOP_STATE_VERSION } from "./types.ts";

/** Absolute lifetime of a loop, measured from `createdAt`. */
export const LOOP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap on simultaneously active loops per session. */
export const MAX_ACTIVE_LOOPS = 5;

/** Fallback wakeup length when a dynamic iteration forgets to reschedule. */
export const DEFAULT_KEEPALIVE_SECONDS = 1200;
export const MIN_KEEPALIVE_SECONDS = 60;
export const MAX_KEEPALIVE_SECONDS = 3600;
export const KEEPALIVE_SECONDS_ENV = "SENPI_LOOP_KEEPALIVE_SECONDS";

/** Dispatched-tick budget per loop. */
export const DEFAULT_MAX_TICKS = 2000;
export const MIN_MAX_TICKS = 1;
export const MAX_TICKS_ENV = "SENPI_LOOP_MAX_TICKS";

export interface LoopClock {
	now(): EpochMs;
}

/**
 * Owns the ONE live timeout per loop. Implementations must apply the generation-counter
 * discipline of `cache-keepalive/index.ts`: re-arming a key replaces its previous
 * callback, and a cancelled callback must never run.
 */
export interface LoopTimerPort {
	arm(key: string, dueAt: EpochMs, callback: () => void): void;
	cancel(key: string): void;
	cancelAll(): void;
}

export interface LoopIdFactory {
	loopId(): LoopId;
	wakeupId(): WakeupId;
	deliveryId(): DeliveryId;
}

export interface LoopSchedulerDeps {
	readonly sessionId: string;
	readonly clock: LoopClock;
	readonly timers: LoopTimerPort;
	readonly ids: LoopIdFactory;
	/** Defaults to `process.env`; injected so tests never mutate the real environment. */
	readonly env?: Record<string, string | undefined>;
	/** Previously persisted state, e.g. on session start. */
	readonly initialState?: LoopState;
	/** Called after every state revision so the caller can persist it. */
	readonly onStateChanged?: (state: LoopState) => void;
	/**
	 * Invoked when an armed timer fires. The owner is expected to run the due decision AND its
	 * side effects (persist + dispatch). Without it the scheduler only advances its own state,
	 * which would deliver a loop's first tick and then silently never recur.
	 */
	readonly onFire?: (loopId: LoopId) => void;
}

export interface CreateFixedRequest {
	readonly originalArgs: string;
	readonly reentryPrompt: string;
	readonly payload: LoopPayload;
	readonly requestedInterval: RequestedInterval;
	readonly effectiveInterval: EffectiveInterval;
	readonly cronExpression: string;
	readonly intervalMs: number;
}

export interface CreateDynamicRequest {
	readonly originalArgs: string;
	readonly reentryPrompt: string;
	readonly payload: LoopPayload;
}

/** One dispatchable delivery. The caller turns this into a message; ticks never steer. */
export interface LoopTick {
	readonly loopId: LoopId;
	readonly deliveryId: DeliveryId;
	/** Occurrence this delivery represents; equal to the `now` it was decided at. */
	readonly scheduledForAt: EpochMs;
	readonly deliverAs: "followUp";
	/** True when this delivery drains a coalesced or recovered occurrence. */
	readonly coalesced: boolean;
}

export type CreateRejectionReason = "active_loop_cap";

export type CreateResult =
	| { readonly ok: true; readonly loopId: LoopId; readonly supersededLoopId?: LoopId }
	| {
			readonly ok: false;
			readonly reason: CreateRejectionReason;
			readonly cap: number;
			readonly activeLoopIds: readonly LoopId[];
			readonly message: string;
	  };

export type DueResult =
	| { readonly action: "dispatch"; readonly tick: LoopTick }
	| { readonly action: "coalesce" }
	| { readonly action: "expire" };

export type TickOutcome = "completed" | "error" | "retrying";

export interface TickSettledInput {
	readonly loopId: LoopId;
	readonly deliveryId: DeliveryId;
	readonly outcome: TickOutcome;
}

export type SettledResult =
	| { readonly action: "dispatch"; readonly tick: LoopTick }
	| { readonly action: "coalesce" }
	| { readonly action: "expire" }
	| { readonly action: "idle" }
	| { readonly action: "in_progress" }
	| { readonly action: "ended"; readonly endReason: LoopEndReason }
	| { readonly action: "ignored" };

export interface ScheduleWakeupInput {
	readonly loopId: LoopId;
	/** Already clamped to `[60, 3600]` by the tool executor. */
	readonly delaySeconds: number;
	readonly requestedDelaySeconds: number;
	readonly reason: string;
	readonly prompt: string;
	readonly noop: boolean;
}

export type ScheduleWakeupResult =
	| {
			readonly ok: true;
			readonly wakeupId: WakeupId;
			readonly replacedWakeupId?: WakeupId;
			readonly dueAt: EpochMs;
			readonly noopStreak: number;
	  }
	| { readonly ok: false; readonly reason: "unknown_loop" | "not_dynamic" | "ended" | "expired" };

export type KeepaliveResult =
	| {
			readonly action: "keepalive_armed";
			readonly wakeupId: WakeupId;
			readonly delaySeconds: number;
			readonly dueAt: EpochMs;
	  }
	| { readonly action: "ended"; readonly endReason: "keepalive_exhausted" | "expired" }
	| { readonly action: "ignored" };

export interface AbortResult {
	readonly action: "paused" | "ignored";
}

export interface TargetedResult {
	readonly affectedLoopIds: readonly LoopId[];
}

export interface ShutdownResult {
	readonly suspendedLoopIds: readonly LoopId[];
}

export interface RestoreOptions {
	/**
	 * Loops the caller knows the user paused explicitly, which must stay paused instead of
	 * being re-armed. `phase: "suspended"` alone cannot express this: shutdown suspends too,
	 * and the persisted state has no field distinguishing the two. Omit it and every
	 * suspended loop is treated as shutdown-suspended and re-armed, per the plan's resume
	 * rule.
	 */
	readonly userPausedLoopIds?: readonly LoopId[];
}

export interface RestoreResult {
	readonly recoveryTicks: readonly LoopTick[];
	readonly expiredLoopIds: readonly LoopId[];
	readonly rearmedLoopIds: readonly LoopId[];
	/** Loops left paused because {@link RestoreOptions.userPausedLoopIds} named them. */
	readonly stillPausedLoopIds: readonly LoopId[];
}

export interface LoopScheduler {
	getState(): LoopState;
	/** State revisions applied so far; lets callers assert atomic multi-entry mutations. */
	readonly mutationCount: number;
	/** Effective dispatched-tick budget after the env override and the minimum of 1. */
	readonly maxTicks: number;
	/** Effective keepalive fallback length in seconds after clamping. */
	readonly keepaliveSeconds: number;
	/** Delivery id of the queued/running tick of a loop, when one is in flight. */
	currentDeliveryId(loopId: LoopId): DeliveryId | undefined;
	createFixed(request: CreateFixedRequest): CreateResult;
	createDynamic(request: CreateDynamicRequest): CreateResult;
	onDue(loopId: LoopId, nowMs: EpochMs, sessionBusy: boolean): DueResult;
	onTickSettled(input: TickSettledInput): SettledResult;
	onScheduleWakeup(request: ScheduleWakeupInput): ScheduleWakeupResult;
	onTurnEndedWithoutSchedule(loopId: LoopId): KeepaliveResult;
	onUserAbort(loopId: LoopId): AbortResult;
	pause(target: LoopId | "all"): TargetedResult;
	resume(target: LoopId | "all"): TargetedResult;
	stop(target: LoopId | "all", detail: string): TargetedResult;
	onShutdown(): ShutdownResult;
	restore(nowMs: EpochMs, options?: RestoreOptions): RestoreResult;
}

/** Phases in which a loop already has a delivery in flight. */
function isInFlight(entry: CronEntry): boolean {
	return entry.phase === "queued" || entry.phase === "running";
}

function isActive(entry: CronEntry): boolean {
	return entry.phase !== "ended";
}

/** Armed means the loop wants its timer running: not ended, not paused. */
function isArmable(entry: CronEntry): boolean {
	return entry.phase !== "ended" && entry.phase !== "suspended";
}

/**
 * THE coalescing rule: the next occurrence is always derived from the CURRENT time, never
 * from the stale due time. That is what makes every occurrence missed during laptop sleep,
 * a long turn, or a pause collapse into exactly one catch-up tick.
 */
function nextOccurrenceAfter(nowMs: EpochMs, intervalMs: number): EpochMs {
	return nowMs + intervalMs;
}

type ActivePhase = Exclude<CronEntry["phase"], "ended">;

/** Fields any loop can carry into a non-terminal transition, regardless of kind. */
type SharedPatch = Partial<Omit<LoopEntryFields, "id" | "createdAt" | "expiresAt">>;

/**
 * Rebuilds an entry in a non-terminal phase, dropping any terminal fields. Spreading an
 * `ended` entry and overriding `phase` would leave `endedAt`/`endReason` behind, which the
 * `LoopLifecycle` union forbids and the store parser rejects, so every non-terminal
 * transition goes through here.
 */
function withPhase(entry: CronEntry, phase: ActivePhase, patch: SharedPatch = {}): CronEntry {
	const { endedAt: _endedAt, endReason: _endReason, endDetail: _endDetail, ...rest } = entry;
	return rest.kind === "fixed"
		? { ...rest, ...patch, kind: "fixed", phase }
		: { ...rest, ...patch, kind: "dynamic", phase };
}

/** Non-terminal transition of a fixed loop, including its recomputed next occurrence. */
function fixedWithPhase(
	entry: FixedCronEntry,
	phase: ActivePhase,
	patch: SharedPatch & { nextFireAt?: EpochMs } = {},
): FixedCronEntry {
	const { endedAt: _endedAt, endReason: _endReason, endDetail: _endDetail, ...rest } = entry;
	return { ...rest, ...patch, kind: "fixed", phase };
}

/** Non-terminal transition of a dynamic loop, including its wakeup and keepalive fields. */
function dynamicWithPhase(
	entry: DynamicCronEntry,
	phase: ActivePhase,
	patch: SharedPatch & { pendingWakeup?: PendingWakeup | null; keepaliveCredit?: 0 | 1 } = {},
): DynamicCronEntry {
	const { endedAt: _endedAt, endReason: _endReason, endDetail: _endDetail, ...rest } = entry;
	return { ...rest, ...patch, kind: "dynamic", phase };
}

function readIntEnv(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw.trim().length === 0) return fallback;
	const parsed = Number(raw.trim());
	if (!Number.isInteger(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

export function createLoopScheduler(deps: LoopSchedulerDeps): LoopScheduler {
	const env = deps.env ?? process.env;
	const keepaliveSeconds = readIntEnv(
		env,
		KEEPALIVE_SECONDS_ENV,
		DEFAULT_KEEPALIVE_SECONDS,
		MIN_KEEPALIVE_SECONDS,
		MAX_KEEPALIVE_SECONDS,
	);
	const maxTicks = readIntEnv(env, MAX_TICKS_ENV, DEFAULT_MAX_TICKS, MIN_MAX_TICKS, Number.MAX_SAFE_INTEGER);

	let state: LoopState = deps.initialState ?? {
		version: LOOP_STATE_VERSION,
		sessionId: deps.sessionId,
		entries: {},
		activeDynamicId: null,
		updatedAt: 0,
	};
	let mutationCount = 0;

	/** In-memory only: which delivery each loop currently has in flight. */
	const inFlightDeliveries = new Map<LoopId, DeliveryId>();

	/**
	 * Applies one atomic state revision. Every transition in this module funnels through
	 * here, so a multi-entry change (e.g. supersede + create) is a single revision and the
	 * persistence callback observes no intermediate state.
	 */
	function commit(update: (entries: Record<LoopId, CronEntry>) => LoopId | null | undefined): void {
		const entries: Record<LoopId, CronEntry> = { ...state.entries };
		const nextDynamicId = update(entries);
		state = {
			version: LOOP_STATE_VERSION,
			sessionId: state.sessionId,
			entries,
			activeDynamicId: nextDynamicId === undefined ? state.activeDynamicId : nextDynamicId,
			updatedAt: deps.clock.now(),
		};
		mutationCount += 1;
		deps.onStateChanged?.(state);
	}

	function entryOf(loopId: LoopId): CronEntry | undefined {
		return state.entries[loopId];
	}

	function activeIds(): LoopId[] {
		return Object.values(state.entries)
			.filter(isActive)
			.map((entry) => entry.id);
	}

	/** Cancels the timer and clears any pending wakeup, then marks the loop ended. */
	function endEntry(
		entries: Record<LoopId, CronEntry>,
		entry: CronEntry,
		nowMs: EpochMs,
		endReason: LoopEndReason,
		endDetail?: string,
	): void {
		deps.timers.cancel(entry.id);
		inFlightDeliveries.delete(entry.id);
		const terminal = {
			phase: "ended" as const,
			endedAt: nowMs,
			endReason,
			...(endDetail === undefined ? {} : { endDetail }),
		};
		entries[entry.id] =
			entry.kind === "fixed" ? { ...entry, ...terminal } : { ...entry, ...terminal, pendingWakeup: null };
	}

	/**
	 * Re-arms a loop's single timer, or ends it as `expired` when the next occurrence would
	 * land at or after expiry. Returns the reason the loop ended, if it did.
	 */
	function armEntry(
		entries: Record<LoopId, CronEntry>,
		entry: CronEntry,
		nowMs: EpochMs,
		onFire: (loopId: LoopId) => void,
	): LoopEndReason | undefined {
		if (nowMs >= entry.expiresAt) {
			endEntry(entries, entry, nowMs, "expired");
			return "expired";
		}
		const dueAt = entry.kind === "fixed" ? entry.nextFireAt : entry.pendingWakeup?.dueAt;
		if (dueAt === undefined) {
			deps.timers.cancel(entry.id);
			return undefined;
		}
		if (dueAt >= entry.expiresAt) {
			// A tick may never fire at or after expiry, so retire the loop now rather than
			// arming a timer that could only produce an illegal delivery.
			endEntry(entries, entry, nowMs, "expired");
			return "expired";
		}
		deps.timers.arm(entry.id, dueAt, () => onFire(entry.id));
		return undefined;
	}

	/** Fire callback the timer port invokes; the extension re-enters through `onDue`. */
	let fireHandler: (loopId: LoopId) => void = () => {};
	function onFire(loopId: LoopId): void {
		fireHandler(loopId);
	}

	function baseFields(nowMs: EpochMs, id: LoopId, request: CreateFixedRequest | CreateDynamicRequest) {
		return {
			id,
			originalArgs: request.originalArgs,
			reentryPrompt: request.reentryPrompt,
			payload: request.payload,
			createdAt: nowMs,
			lastFiredAt: null,
			expiresAt: nowMs + LOOP_EXPIRY_MS,
			lastScheduledForAt: null,
			coalescedFirePending: false,
			queuedForAt: null,
			noopStreak: 0,
			tickCount: 0,
			sentinelDelivery: {
				autonomousPreambleDelivered: false,
				lastLoopFileDelivered: null,
				forceFullDelivery: false,
			},
			wakeSources: [],
		};
	}

	function capRejection(): CreateResult {
		const active = activeIds();
		return {
			ok: false,
			reason: "active_loop_cap",
			cap: MAX_ACTIVE_LOOPS,
			activeLoopIds: active,
			message:
				`At most ${MAX_ACTIVE_LOOPS} loops can be active at once. Active: ${active.join(", ")}. ` +
				"Stop one with `/loop stop <id>` or `/loop stop all` first.",
		};
	}

	function createFixed(request: CreateFixedRequest): CreateResult {
		if (activeIds().length >= MAX_ACTIVE_LOOPS) return capRejection();
		const nowMs = deps.clock.now();
		const id = deps.ids.loopId();
		commit((entries) => {
			const entry: FixedCronEntry = {
				...baseFields(nowMs, id, request),
				kind: "fixed",
				phase: "waiting",
				requestedInterval: request.requestedInterval,
				effectiveInterval: request.effectiveInterval,
				cronExpression: request.cronExpression,
				nextFireAt: nextOccurrenceAfter(nowMs, request.intervalMs),
				intervalMs: request.intervalMs,
			};
			entries[id] = entry;
			// Arm before the caller dispatches the immediate first tick, so a failing first
			// turn cannot silently lose the recurring schedule.
			armEntry(entries, entry, nowMs, onFire);
			return undefined;
		});
		return { ok: true, loopId: id };
	}

	function createDynamic(request: CreateDynamicRequest): CreateResult {
		const existingDynamicId = state.activeDynamicId;
		const existing = existingDynamicId === null ? undefined : entryOf(existingDynamicId);
		const supersedes = existing !== undefined && isActive(existing);
		// A superseded loop frees its slot, so it must not count against the cap.
		const activeAfterSupersede = activeIds().filter((id) => !(supersedes && id === existingDynamicId));
		if (activeAfterSupersede.length >= MAX_ACTIVE_LOOPS) return capRejection();

		const nowMs = deps.clock.now();
		const id = deps.ids.loopId();
		commit((entries) => {
			if (supersedes && existing !== undefined) {
				endEntry(entries, existing, nowMs, "stopped", "superseded");
			}
			const entry: DynamicCronEntry = {
				...baseFields(nowMs, id, request),
				kind: "dynamic",
				phase: "waiting",
				pendingWakeup: null,
				keepaliveCredit: 1,
			};
			entries[id] = entry;
			return id;
		});
		return supersedes && existingDynamicId !== null
			? { ok: true, loopId: id, supersededLoopId: existingDynamicId }
			: { ok: true, loopId: id };
	}

	function onDue(loopId: LoopId, nowMs: EpochMs, sessionBusy: boolean): DueResult {
		const entry = entryOf(loopId);
		if (entry === undefined) return { action: "coalesce" };

		if (nowMs >= entry.expiresAt) {
			if (entry.phase === "ended") return { action: "coalesce" };
			commit((entries) => {
				endEntry(entries, entry, nowMs, "expired");
				return undefined;
			});
			return { action: "expire" };
		}
		if (entry.phase === "ended" || entry.phase === "suspended") return { action: "coalesce" };
		if (entry.tickCount >= maxTicks) return { action: "coalesce" };

		if (isInFlight(entry)) {
			// Invariant: one queued/running tick per loop. Extra occurrences collapse into a
			// single pending bit and the schedule still moves forward from `now`.
			commit((entries) => {
				const coalesced =
					entry.kind === "fixed"
						? fixedWithPhase(entry, entry.phase, {
								coalescedFirePending: true,
								nextFireAt: nextOccurrenceAfter(nowMs, entry.intervalMs),
							})
						: dynamicWithPhase(entry, entry.phase, { coalescedFirePending: true });
				entries[loopId] = coalesced;
				armEntry(entries, coalesced, nowMs, onFire);
				return undefined;
			});
			return { action: "coalesce" };
		}

		const deliveryId = deps.ids.deliveryId();
		const tick: LoopTick = {
			loopId,
			deliveryId,
			scheduledForAt: nowMs,
			deliverAs: "followUp",
			coalesced: entry.coalescedFirePending,
		};
		let expired = false;
		commit((entries) => {
			const dispatched = {
				lastFiredAt: nowMs,
				lastScheduledForAt: nowMs,
				queuedForAt: nowMs,
				coalescedFirePending: false,
				tickCount: entry.tickCount + 1,
			};
			const phase = sessionBusy ? ("queued" as const) : ("running" as const);
			const next =
				entry.kind === "fixed"
					? fixedWithPhase(entry, phase, {
							...dispatched,
							nextFireAt: nextOccurrenceAfter(nowMs, entry.intervalMs),
						})
					: dynamicWithPhase(entry, phase, { ...dispatched, pendingWakeup: null });
			entries[loopId] = next;
			// A dynamic loop has no schedule of its own; its next timer comes from
			// schedule_wakeup or the keepalive fallback.
			if (next.kind === "fixed") {
				expired = armEntry(entries, next, nowMs, onFire) === "expired";
			} else {
				deps.timers.cancel(loopId);
			}
			return undefined;
		});
		if (!expired) inFlightDeliveries.set(loopId, deliveryId);
		return { action: "dispatch", tick };
	}

	function onTickSettled(input: TickSettledInput): SettledResult {
		const entry = entryOf(input.loopId);
		if (entry === undefined) return { action: "ignored" };
		if (input.outcome === "retrying") return { action: "in_progress" };
		if (inFlightDeliveries.get(input.loopId) !== input.deliveryId) return { action: "ignored" };
		inFlightDeliveries.delete(input.loopId);
		if (entry.phase === "ended") return { action: "ignored" };
		// A user abort already paused this loop; settling must not resurrect it.
		if (entry.phase === "suspended") return { action: "idle" };

		const nowMs = deps.clock.now();

		if (nowMs >= entry.expiresAt) {
			commit((entries) => {
				endEntry(entries, entry, nowMs, "expired");
				return undefined;
			});
			return { action: "ended", endReason: "expired" };
		}

		if (entry.tickCount >= maxTicks) {
			// The budget bounds spend, not wall clock: expiry alone would let a `/loop 1m`
			// job reach thousands of model turns.
			commit((entries) => {
				endEntry(entries, entry, nowMs, "tick_budget_exhausted");
				return undefined;
			});
			return { action: "ended", endReason: "tick_budget_exhausted" };
		}

		if (entry.coalescedFirePending) {
			// Exactly one delivery drains the coalesced occurrence, however many were missed.
			commit((entries) => {
				entries[input.loopId] = withPhase(entry, "waiting", { coalescedFirePending: false, queuedForAt: null });
				return undefined;
			});
			return onDue(input.loopId, nowMs, false);
		}

		let expired = false;
		commit((entries) => {
			const settled = withPhase(entry, "waiting", { queuedForAt: null });
			entries[input.loopId] = settled;
			if (settled.kind === "fixed") {
				expired = armEntry(entries, settled, nowMs, onFire) === "expired";
			}
			return undefined;
		});
		return expired ? { action: "ended", endReason: "expired" } : { action: "idle" };
	}

	function onScheduleWakeup(request: ScheduleWakeupInput): ScheduleWakeupResult {
		const entry = entryOf(request.loopId);
		if (entry === undefined) return { ok: false, reason: "unknown_loop" };
		if (entry.kind !== "dynamic") return { ok: false, reason: "not_dynamic" };
		if (entry.phase === "ended") return { ok: false, reason: "ended" };

		const nowMs = deps.clock.now();
		if (nowMs >= entry.expiresAt) {
			commit((entries) => {
				endEntry(entries, entry, nowMs, "expired");
				return undefined;
			});
			return { ok: false, reason: "expired" };
		}

		const wakeupId = deps.ids.wakeupId();
		const replacedWakeupId = entry.pendingWakeup?.id;
		// Expiry is absolute: a new wakeup never extends `expiresAt`.
		const dueAt = nowMs + request.delaySeconds * 1000;
		const wakeup: PendingWakeup = {
			id: wakeupId,
			loopId: entry.id,
			kind: "dynamic",
			source: "model",
			requestedDelaySeconds: request.requestedDelaySeconds,
			delaySeconds: request.delaySeconds,
			dueAt,
			reason: request.reason,
			prompt: request.prompt,
			noop: request.noop,
			createdAt: nowMs,
		};
		const noopStreak = request.noop ? entry.noopStreak + 1 : 0;
		commit((entries) => {
			const scheduled = dynamicWithPhase(entry, "waiting", {
				queuedForAt: null,
				pendingWakeup: wakeup,
				// A successful model schedule restores the one-omission recovery budget.
				keepaliveCredit: 1,
				noopStreak,
			});
			entries[entry.id] = scheduled;
			armEntry(entries, scheduled, nowMs, onFire);
			return undefined;
		});
		return replacedWakeupId === undefined
			? { ok: true, wakeupId, dueAt, noopStreak }
			: { ok: true, wakeupId, replacedWakeupId, dueAt, noopStreak };
	}

	function onTurnEndedWithoutSchedule(loopId: LoopId): KeepaliveResult {
		const entry = entryOf(loopId);
		if (entry === undefined || entry.kind !== "dynamic") return { action: "ignored" };
		// Fixed loops re-arm from their own schedule, and a paused or ended loop has no
		// liveness to protect. A user abort lands here as `suspended`, which is exactly why
		// an abort can never be converted into a keepalive omission.
		if (entry.phase === "ended" || entry.phase === "suspended") return { action: "ignored" };

		const nowMs = deps.clock.now();
		if (nowMs >= entry.expiresAt) {
			commit((entries) => {
				endEntry(entries, entry, nowMs, "expired");
				return undefined;
			});
			return { action: "ended", endReason: "expired" };
		}

		if (entry.keepaliveCredit === 0) {
			commit((entries) => {
				endEntry(entries, entry, nowMs, "keepalive_exhausted");
				return undefined;
			});
			return { action: "ended", endReason: "keepalive_exhausted" };
		}

		const wakeupId = deps.ids.wakeupId();
		const dueAt = nowMs + keepaliveSeconds * 1000;
		const wakeup: PendingWakeup = {
			id: wakeupId,
			loopId: entry.id,
			kind: "dynamic",
			source: "keepalive",
			requestedDelaySeconds: keepaliveSeconds,
			delaySeconds: keepaliveSeconds,
			dueAt,
			reason: "keepalive armed (model did not reschedule)",
			prompt: entry.reentryPrompt,
			noop: false,
			createdAt: nowMs,
		};
		let expired = false;
		commit((entries) => {
			const armed = dynamicWithPhase(entry, "waiting", {
				queuedForAt: null,
				pendingWakeup: wakeup,
				keepaliveCredit: 0,
			});
			entries[entry.id] = armed;
			expired = armEntry(entries, armed, nowMs, onFire) === "expired";
			return undefined;
		});
		return expired
			? { action: "ended", endReason: "expired" }
			: { action: "keepalive_armed", wakeupId, delaySeconds: keepaliveSeconds, dueAt };
	}

	function pauseEntries(ids: readonly LoopId[]): LoopId[] {
		const affected: LoopId[] = [];
		const pausable = ids
			.map((id) => entryOf(id))
			.filter((entry): entry is CronEntry => entry !== undefined && isArmable(entry));
		if (pausable.length === 0) return affected;
		commit((entries) => {
			for (const entry of pausable) {
				deps.timers.cancel(entry.id);
				inFlightDeliveries.delete(entry.id);
				entries[entry.id] = withPhase(entry, "suspended", { queuedForAt: null });
				affected.push(entry.id);
			}
			return undefined;
		});
		return affected;
	}

	function resolveTargets(target: LoopId | "all"): LoopId[] {
		if (target !== "all") return [target];
		return Object.values(state.entries).map((entry) => entry.id);
	}

	function pause(target: LoopId | "all"): TargetedResult {
		return { affectedLoopIds: pauseEntries(resolveTargets(target)) };
	}

	function onUserAbort(loopId: LoopId): AbortResult {
		// Esc is also how a user interrupts to steer, so an abort PAUSES the loop; the
		// schedule survives for `/loop resume` and is never a terminal state.
		const affected = pauseEntries([loopId]);
		return { action: affected.length > 0 ? "paused" : "ignored" };
	}

	function resume(target: LoopId | "all"): TargetedResult {
		const nowMs = deps.clock.now();
		const resumable = resolveTargets(target)
			.map((id) => entryOf(id))
			.filter((entry): entry is CronEntry => entry !== undefined && entry.phase === "suspended");
		if (resumable.length === 0) return { affectedLoopIds: [] };
		const affected: LoopId[] = [];
		commit((entries) => {
			for (const entry of resumable) {
				// The occurrence missed while paused is not replayed: the next fire is
				// recomputed from now, exactly as after a sleep.
				const rearmed =
					entry.kind === "fixed"
						? fixedWithPhase(entry, "waiting", {
								queuedForAt: null,
								nextFireAt: nextOccurrenceAfter(nowMs, entry.intervalMs),
							})
						: dynamicWithPhase(entry, "waiting", {
								queuedForAt: null,
								pendingWakeup:
									entry.pendingWakeup === null
										? null
										: { ...entry.pendingWakeup, dueAt: Math.max(entry.pendingWakeup.dueAt, nowMs) },
							});
				entries[entry.id] = rearmed;
				armEntry(entries, rearmed, nowMs, onFire);
				affected.push(entry.id);
			}
			return undefined;
		});
		return { affectedLoopIds: affected };
	}

	function stop(target: LoopId | "all", detail: string): TargetedResult {
		const nowMs = deps.clock.now();
		const stoppable = resolveTargets(target)
			.map((id) => entryOf(id))
			.filter((entry): entry is CronEntry => entry !== undefined && isActive(entry));
		if (stoppable.length === 0) return { affectedLoopIds: [] };
		const affected: LoopId[] = [];
		let clearDynamic = false;
		commit((entries) => {
			for (const entry of stoppable) {
				endEntry(entries, entry, nowMs, "stopped", detail);
				if (entry.id === state.activeDynamicId) clearDynamic = true;
				affected.push(entry.id);
			}
			return clearDynamic ? null : undefined;
		});
		return { affectedLoopIds: affected };
	}

	function onShutdown(): ShutdownResult {
		// Every senpi shutdown reason (quit|reload|new|resume|fork) leaves the session
		// resumable, so shutdown SUSPENDS and emits no terminal reason.
		const suspendable = Object.values(state.entries).filter(isArmable);
		deps.timers.cancelAll();
		if (suspendable.length === 0) return { suspendedLoopIds: [] };
		const suspended: LoopId[] = [];
		commit((entries) => {
			for (const entry of suspendable) {
				entries[entry.id] = withPhase(entry, "suspended", { queuedForAt: null });
				suspended.push(entry.id);
			}
			return undefined;
		});
		inFlightDeliveries.clear();
		return { suspendedLoopIds: suspended };
	}

	function restore(nowMs: EpochMs, options: RestoreOptions = {}): RestoreResult {
		const recoveryTicks: LoopTick[] = [];
		const expiredLoopIds: LoopId[] = [];
		const rearmedLoopIds: LoopId[] = [];
		const stillPausedLoopIds: LoopId[] = [];
		const userPaused = new Set(options.userPausedLoopIds ?? []);
		// A delivery this process still has in flight is NOT a crash remnant; only state
		// whose owning process is gone needs recovering.
		const liveDeliveries = new Set(inFlightDeliveries.keys());
		deps.timers.cancelAll();

		commit((entries) => {
			for (const entry of Object.values(state.entries)) {
				if (entry.phase === "ended") continue;
				// A delivery this process still owns is in flight, not a crash remnant: leave it
				// alone so restore can never duplicate a tick that is already running.
				if (liveDeliveries.has(entry.id)) continue;
				if (userPaused.has(entry.id)) {
					// An explicit `/loop pause` outlives a restart: no timer, no recovery tick.
					entries[entry.id] = withPhase(entry, "suspended", { queuedForAt: null });
					stillPausedLoopIds.push(entry.id);
					continue;
				}
				if (nowMs >= entry.expiresAt) {
					endEntry(entries, entry, nowMs, "expired");
					expiredLoopIds.push(entry.id);
					continue;
				}
				// A crashed `starting`/`queued`/`running` remnant, a pending coalesced fire, and
				// an overdue occurrence all collapse into ONE recovery delivery per job.
				const dueAt = entry.kind === "fixed" ? entry.nextFireAt : entry.pendingWakeup?.dueAt;
				const overdue = dueAt !== undefined && dueAt <= nowMs;
				const crashRemnant = isInFlight(entry) || entry.phase === "starting";
				const needsRecovery = (overdue || crashRemnant || entry.coalescedFirePending) && entry.tickCount < maxTicks;

				const recovered =
					entry.kind === "fixed"
						? fixedWithPhase(entry, "waiting", {
								queuedForAt: null,
								coalescedFirePending: false,
								nextFireAt: nextOccurrenceAfter(nowMs, entry.intervalMs),
							})
						: dynamicWithPhase(entry, "waiting", {
								queuedForAt: null,
								coalescedFirePending: false,
								// The one-shot wakeup is consumed by the recovery delivery.
								pendingWakeup: overdue ? null : entry.pendingWakeup,
							});
				entries[entry.id] = recovered;
				const ended = armEntry(entries, recovered, nowMs, onFire);
				if (ended === "expired") {
					expiredLoopIds.push(entry.id);
					continue;
				}
				if (needsRecovery) {
					const deliveryId = deps.ids.deliveryId();
					recoveryTicks.push({
						loopId: entry.id,
						deliveryId,
						scheduledForAt: nowMs,
						deliverAs: "followUp",
						coalesced: true,
					});
				}
				rearmedLoopIds.push(entry.id);
			}
			return undefined;
		});

		// Recovery deliveries count as dispatched ticks and occupy the single in-flight slot.
		// One revision for all of them, so a persisting caller never sees a partial recovery.
		if (recoveryTicks.length > 0) {
			commit((entries) => {
				for (const tick of recoveryTicks) {
					const entry = entries[tick.loopId];
					if (entry === undefined || entry.phase === "ended") continue;
					entries[tick.loopId] = withPhase(entry, "queued", {
						lastFiredAt: nowMs,
						lastScheduledForAt: nowMs,
						queuedForAt: nowMs,
						tickCount: entry.tickCount + 1,
					});
					inFlightDeliveries.set(tick.loopId, tick.deliveryId);
				}
				return undefined;
			});
		}

		return { recoveryTicks, expiredLoopIds, rearmedLoopIds, stillPausedLoopIds };
	}

	const scheduler: LoopScheduler = {
		getState: () => state,
		get mutationCount() {
			return mutationCount;
		},
		maxTicks,
		keepaliveSeconds,
		currentDeliveryId: (loopId) => inFlightDeliveries.get(loopId),
		createFixed,
		createDynamic,
		onDue,
		onTickSettled,
		onScheduleWakeup,
		onTurnEndedWithoutSchedule,
		onUserAbort,
		pause,
		resume,
		stop,
		onShutdown,
		restore,
	};

	// The timer port fires with a loop id; the due decision is always re-derived from the
	// clock so a stale callback cannot dispatch a tick the state machine would refuse.
	// When an owner supplies `onFire` it performs the whole due step (persist + dispatch), so
	// calling `onDue` here as well would consume the occurrence and drop the delivery.
	fireHandler = (loopId) => {
		const owner = deps.onFire;
		if (owner !== undefined) {
			owner(loopId);
			return;
		}
		scheduler.onDue(loopId, deps.clock.now(), false);
	};

	return scheduler;
}
