/**
 * `/loop` extension factory and lifecycle wiring.
 *
 * This module owns the only impure parts of the feature: real timers, the session store,
 * the extension event wiring, and message dispatch. Every decision it makes is delegated
 * to the pure modules beside it (`scheduler.ts`, `tick-prompt.ts`, `cron-planner.ts`,
 * `loopfile.ts`, `status.ts`), so the runtime here is a thin, testable adapter.
 *
 * Load-bearing rules implemented here:
 * - A tick NEVER steers. Idle dispatch goes through `sendUserMessage(..., {
 *   expandPromptTemplates: true })` so a slash payload reaches the real command path;
 *   a busy session receives the tick as a follow-up instead.
 * - Shutdown SUSPENDS: timers are cancelled, the ticker disposed, and the snapshot is
 *   persisted without a terminal reason (every senpi shutdown reason is resumable).
 * - Keepalive is applied only to an attributed dynamic iteration, never after an ordinary
 *   user turn, and never after a user abort (an abort PAUSES the loop instead).
 * - A store failure is not swallowed: the affected loops end with `error` and the user is
 *   told, because a schedule that cannot be persisted must not keep running.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../../../../config.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import { noticeEntryRenderer } from "../../notice/index.ts";
import type { EntryRenderer, ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../types.ts";
import { registerLoopCommand } from "./command-registration.ts";
import { describeCron, normalizeInterval } from "./cron-planner.ts";
import { type LoopFileResult, nodeFs, resolveLoopFile as resolveLoopFileDefault } from "./loopfile.ts";
import {
	createLoopScheduler,
	type LoopClock,
	type LoopIdFactory,
	type LoopScheduler,
	type LoopTick,
	type LoopTimerPort,
} from "./scheduler.ts";
import { formatLoopStatus, formatNoopFold, LoopStatusTicker } from "./status.ts";
import { readLoopState, writeLoopState } from "./store.ts";
import { buildTickMessage, type LoopFileSnapshot, type LoopMode, type TickDelivery } from "./tick-prompt.ts";
import { registerLoopTools, type ScheduleWakeupTarget } from "./tools.ts";
import type {
	CronEntry,
	DeliveryId,
	EpochMs,
	LoopEndReason,
	LoopId,
	LoopPayload,
	LoopSentinel,
	LoopState,
	LoopStoreRef,
	RequestedInterval,
	SentinelDeliveryState,
} from "./types.ts";

/** Custom entry type carrying one dispatched tick, used for attribution and folding. */
export const LOOP_TICK_ENTRY_TYPE = "loop-tick";

export interface LoopTickEntryData {
	readonly loopId: LoopId;
	readonly deliveryId: DeliveryId;
	readonly scheduledForAt: EpochMs;
	readonly mode: LoopMode;
	readonly delivery: TickDelivery;
	readonly sentinel?: LoopSentinel;
	/** Consecutive quiet dynamic iterations at the moment this tick was dispatched. */
	readonly noopStreak: number;
	/** True when this tick continues a quiet streak and should render folded. */
	readonly folded: boolean;
}

export interface LoopCreateOk {
	readonly ok: true;
	readonly loopId: LoopId;
	/** Present when a new dynamic loop replaced a previous one. */
	readonly supersededLoopId?: LoopId;
	/** Human-readable rounding notice when the requested cadence was normalized. */
	readonly roundingNotice?: string;
	readonly cronExpression?: string;
	readonly effectiveCadence?: string;
	readonly expiresAt?: EpochMs;
}

export interface LoopCreateRejected {
	readonly ok: false;
	readonly message: string;
}

export type LoopCreateOutcome = LoopCreateOk | LoopCreateRejected;

export interface LoopStoreFailure {
	readonly endReason: LoopEndReason;
	readonly message: string;
	readonly loopIds: readonly LoopId[];
}

export interface StartFixedRequest {
	readonly originalArgs: string;
	readonly prompt: string;
	readonly requestedInterval: RequestedInterval;
}

export interface StartDynamicRequest {
	readonly originalArgs: string;
	readonly prompt: string;
}

export interface StartBareRequest {
	readonly originalArgs: string;
	readonly interval?: RequestedInterval;
}

export interface ControllerScheduleWakeupRequest {
	readonly loopId: LoopId;
	readonly requestedDelaySeconds: number;
	readonly delaySeconds: number;
	readonly reason: string;
	readonly prompt: string;
	readonly noop: boolean;
}

/**
 * Runtime surface of a live loop extension. The `/loop` command module drives the
 * extension exclusively through this interface, so command parsing never reaches into
 * scheduler or store internals.
 */
export interface LoopController {
	startFixed(request: StartFixedRequest): Promise<LoopCreateOutcome>;
	startDynamic(request: StartDynamicRequest): Promise<LoopCreateOutcome>;
	startBare(request: StartBareRequest): Promise<LoopCreateOutcome>;
	/** Runs the due decision for a loop at the current clock reading and dispatches it. */
	fireDue(loopId: LoopId): Promise<void>;
	scheduleWakeup(request: ControllerScheduleWakeupRequest): Promise<void>;
	stop(target: LoopId | "all", detail: string): Promise<readonly LoopId[]>;
	pause(target: LoopId | "all"): Promise<readonly LoopId[]>;
	resume(target: LoopId | "all"): Promise<readonly LoopId[]>;
	getState(): LoopState;
	statusLine(): string | undefined;
	/** Set when a store read/write failed and the affected loops were ended with `error`. */
	lastStoreFailure(): LoopStoreFailure | undefined;
	/** True when this loop was retired because its state could not be read or written. */
	isEndedWithError(loopId: LoopId): boolean;
}

export interface LoopExtensionDeps {
	readonly clock?: LoopClock;
	/** Factory so each session gets its own timer port; defaults to real timeouts. */
	readonly timers?: () => LoopTimerPort;
	readonly ids?: LoopIdFactory;
	readonly storeRef?: (ctx: ExtensionContext) => LoopStoreRef;
	readonly resolveLoopFile?: (options: { cwd: string; homeDir: string }) => Promise<LoopFileResult>;
	readonly readState?: (ref: LoopStoreRef) => Promise<LoopState | null>;
	readonly writeState?: (ref: LoopStoreRef, state: LoopState) => Promise<void>;
	/**
	 * Published at factory time so a command module (or a test) can drive this instance.
	 * The controller is bound to the extension's own session state, so it stays valid across
	 * session starts within one extension generation.
	 */
	readonly onControllerReady?: (controller: LoopController) => void;
}

export const renderLoopTickEntry: EntryRenderer<LoopTickEntryData> = noticeEntryRenderer((entry) => {
	const data = entry.data;
	if (data === undefined) return undefined;
	const folded = data.folded ? formatNoopFold(data.noopStreak) : "";
	if (folded.length > 0) {
		return {
			title: folded,
			why: "Consecutive loop ticks reported no actionable change.",
		};
	}
	return {
		title: `↻ loop tick (${data.mode}) · ${data.delivery}`,
		why: "A /loop schedule dispatched this tick.",
	};
});

/**
 * Real timer port: exactly one live timeout per key, replaced on re-arm.
 *
 * Follows the generation-counter discipline of `cache-keepalive/index.ts`: cancelling or
 * re-arming a key bumps its generation, so a callback whose generation is stale returns
 * without firing even if it was already scheduled on the event loop.
 */
export function createNodeTimerPort(): LoopTimerPort {
	const handles = new Map<string, ReturnType<typeof setTimeout>>();
	const generations = new Map<string, number>();

	function cancel(key: string): void {
		const handle = handles.get(key);
		if (handle !== undefined) clearTimeout(handle);
		handles.delete(key);
		generations.set(key, (generations.get(key) ?? 0) + 1);
	}

	return {
		arm(key, dueAt, callback) {
			cancel(key);
			const generation = generations.get(key) ?? 0;
			const delayMs = Math.max(0, dueAt - Date.now());
			const handle = setTimeout(() => {
				handles.delete(key);
				if (generations.get(key) !== generation) return;
				callback();
			}, delayMs);
			handle.unref?.();
			handles.set(key, handle);
		},
		cancel,
		cancelAll() {
			for (const key of [...handles.keys()]) cancel(key);
		},
	};
}

function defaultIds(): LoopIdFactory {
	let sequence = 0;
	const mint = (prefix: string): string => {
		sequence += 1;
		return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
	};
	return {
		loopId: () => mint("loop"),
		wakeupId: () => mint("wakeup"),
		deliveryId: () => mint("delivery"),
	};
}

function defaultStoreRef(ctx: ExtensionContext): LoopStoreRef {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const baseDir =
		sessionFile === undefined
			? join(getAgentDir(), "extensions", "loop", "no-session")
			: join(ctx.sessionManager.getSessionDir(), "extensions", "loop");
	return { baseDir, sessionId: ctx.sessionManager.getSessionId() };
}

function emptyDeliveryState(): SentinelDeliveryState {
	return { autonomousPreambleDelivered: false, lastLoopFileDelivered: null, forceFullDelivery: false };
}

function loopFileSnapshot(result: LoopFileResult): LoopFileSnapshot {
	if (!result.found) return { present: false };
	return {
		present: true,
		path: result.path,
		content: result.content,
		mtimeMs: result.fingerprint.mtimeMs,
		size: result.fingerprint.size,
		contentHash: result.fingerprint.contentHash,
	};
}

function sentinelFor(mode: LoopMode, loopFilePresent: boolean): LoopSentinel {
	if (loopFilePresent) return mode === "fixed" ? "<<loop.md>>" : "<<loop.md-dynamic>>";
	return mode === "fixed" ? "<<autonomous-loop>>" : "<<autonomous-loop-dynamic>>";
}

function modeOf(entry: CronEntry): LoopMode {
	return entry.kind === "fixed" ? "fixed" : "dynamic";
}

interface AnchorPayload {
	readonly loopId?: string;
	readonly deliveryId?: string;
}

/** Reads the tick payload of a `loop-tick` entry, whichever entry kind carries it. */
function anchorPayloadOf(entry: SessionEntry): AnchorPayload | undefined {
	if (entry.type === "custom") {
		return entry.customType === LOOP_TICK_ENTRY_TYPE ? (entry.data as AnchorPayload | undefined) : undefined;
	}
	if (entry.type === "custom_message") {
		return entry.customType === LOOP_TICK_ENTRY_TYPE ? (entry.details as AnchorPayload | undefined) : undefined;
	}
	return undefined;
}

/**
 * True when the compaction-aware context still contains the delivery that anchored a full
 * sentinel block. Compaction can drop it, and a reminder's "established earlier in this
 * conversation" phrasing must never dangle, so a missing anchor forces the next tick back
 * to full. When no specific anchor id was recorded (the autonomous preamble carries none),
 * any surviving tick delivery for that loop counts as the anchor.
 */
function anchorPresent(ctx: ExtensionContext, loopId: LoopId, deliveryId: DeliveryId | undefined): boolean {
	return ctx.sessionManager.buildContextEntries().some((entry) => {
		const payload = anchorPayloadOf(entry);
		if (payload === undefined) return false;
		if (payload.loopId !== undefined && payload.loopId !== loopId) return false;
		return deliveryId === undefined ? true : payload.deliveryId === deliveryId;
	});
}

export function createLoopExtension(deps: LoopExtensionDeps = {}): ExtensionFactory {
	const clock: LoopClock = deps.clock ?? { now: () => Date.now() };
	const makeTimers = deps.timers ?? createNodeTimerPort;
	const ids = deps.ids ?? defaultIds();
	const storeRefOf = deps.storeRef ?? defaultStoreRef;
	const resolveLoopFile =
		deps.resolveLoopFile ??
		((options: { cwd: string; homeDir: string }) =>
			resolveLoopFileDefault({ cwd: options.cwd, homeDir: options.homeDir, fs: nodeFs, path: { join } }));
	const readState = deps.readState ?? readLoopState;
	const writeState = deps.writeState ?? writeLoopState;

	return (pi: ExtensionAPI) => {
		let ctx: ExtensionContext | undefined;
		let scheduler: LoopScheduler | undefined;
		let storeRef: LoopStoreRef | undefined;
		let timers: LoopTimerPort = makeTimers();
		let storeFailure: LoopStoreFailure | undefined;
		let sessionNamed = false;
		/** Loop the currently running iteration is attributed to, for keepalive + tools. */
		let attributedLoopId: LoopId | undefined;
		/** Delivery id of the tick that started the attributed iteration. */
		let attributedDeliveryId: DeliveryId | undefined;
		/** True once the attributed iteration rescheduled or stopped itself. */
		let attributionResolved = false;
		/** Ticks held back because their slash payload cannot be queued while streaming. */
		const deferredDispatches: LoopTick[] = [];
		const deliveryStates = new Map<LoopId, SentinelDeliveryState>();
		/** Loops retired with `error` because their state could not be read or written. */
		const endedWithError = new Set<LoopId>();
		/** True once this session has state worth persisting (loaded or created). */
		let storeTouched = false;
		let persistTail: Promise<void> = Promise.resolve();

		const ticker = new LoopStatusTicker({
			render: (key, text) => {
				try {
					ctx?.ui.setStatus(key, text);
				} catch {
					// A stale context after session replacement must not break the loop runtime.
				}
			},
			now: () => clock.now(),
		});

		pi.registerEntryRenderer(LOOP_TICK_ENTRY_TYPE, renderLoopTickEntry);
		registerLoopTools(pi, {
			scheduler: {
				getWakeupTarget: (): ScheduleWakeupTarget => {
					if (scheduler === undefined || attributedLoopId === undefined) return null;
					const entry = scheduler.getState().entries[attributedLoopId];
					if (entry === undefined || entry.phase === "ended") return null;
					return { kind: entry.kind, loopId: entry.id };
				},
				scheduleWakeup: async (request) => {
					const active = requireScheduler();
					const result = active.onScheduleWakeup(request);
					if (!result.ok) throw new Error(`schedule_wakeup rejected: ${result.reason}`);
					attributionResolved = true;
					await persist();
					refreshStatus();
					return {
						wakeupId: result.wakeupId,
						...(result.replacedWakeupId === undefined ? {} : { replacedWakeupId: result.replacedWakeupId }),
						dueAt: result.dueAt,
						noopStreak: result.noopStreak,
					};
				},
				stopDynamicLoop: async (request) => {
					const active = requireScheduler();
					active.stop(request.loopId, "model-stop");
					attributionResolved = true;
					await persist();
					refreshStatus();
					return { endedAt: clock.now() };
				},
			},
		});

		function requireScheduler(): LoopScheduler {
			if (scheduler === undefined) throw new Error("loop extension has no active session");
			return scheduler;
		}

		/** Merges extension-owned sentinel delivery state into the scheduler's snapshot. */
		function withDeliveryOverlay(state: LoopState): LoopState {
			const entries: Record<LoopId, CronEntry> = {};
			for (const [id, entry] of Object.entries(state.entries)) {
				const delivery = deliveryStates.get(id);
				entries[id] = delivery === undefined ? entry : { ...entry, sentinelDelivery: delivery };
			}
			return { ...state, entries };
		}

		/** Serializes persistence so a timer, tool, and command write cannot interleave. */
		function persist(): Promise<void> {
			const ref = storeRef;
			const active = scheduler;
			if (ref === undefined || active === undefined) return Promise.resolve();
			const snapshot = withDeliveryOverlay(active.getState());
			// The extension is registered for every session, so a session that never ran a loop
			// must not leave a sidecar behind.
			if (!storeTouched && Object.keys(snapshot.entries).length === 0) return Promise.resolve();
			storeTouched = true;
			persistTail = persistTail.then(async () => {
				try {
					await writeState(ref, snapshot);
				} catch (error) {
					failStore(error, Object.keys(snapshot.entries));
				}
			});
			return persistTail;
		}

		/**
		 * A schedule that cannot be read or written must not keep running: end the affected
		 * loops with `error` and tell the user, rather than silently losing the schedule. The
		 * terminal record is kept in memory because the store that would hold it is exactly the
		 * thing that just failed; what matters is that nothing stays armed and the user knows.
		 */
		function failStore(error: unknown, loopIds: readonly LoopId[]): void {
			const message = error instanceof Error ? error.message : String(error);
			timers.cancelAll();
			for (const loopId of loopIds) endedWithError.add(loopId);
			storeFailure = {
				endReason: "error",
				message,
				loopIds,
			};
			ticker.dispose();
			ctx?.ui.notify(`/loop state could not be used and the affected loops were ended: ${message}`, "error");
		}

		function refreshStatus(): void {
			if (scheduler === undefined) return;
			const state = scheduler.getState();
			// The ticker owns a repeating render timer, so it only runs while a loop is armed;
			// a session that never used /loop must not carry one.
			if (Object.values(state.entries).every((entry) => entry.phase === "ended")) {
				if (ticker.running) ticker.dispose();
				return;
			}
			ticker.sync(state);
		}

		function deliveryStateOf(loopId: LoopId): SentinelDeliveryState {
			return deliveryStates.get(loopId) ?? emptyDeliveryState();
		}

		function markForceFullDelivery(): void {
			for (const [id, state] of deliveryStates) {
				deliveryStates.set(id, { ...state, forceFullDelivery: true });
			}
			const active = scheduler;
			if (active === undefined) return;
			for (const entry of Object.values(active.getState().entries)) {
				if (entry.phase === "ended") continue;
				if (deliveryStates.has(entry.id)) continue;
				deliveryStates.set(entry.id, { ...entry.sentinelDelivery, forceFullDelivery: true });
			}
		}

		function isExtensionCommandPayload(text: string): boolean {
			if (!text.startsWith("/")) return false;
			const name = text.slice(1).split(/\s+/)[0];
			return pi.getCommands().some((command) => command.name === name);
		}

		/**
		 * Delivers one tick. Idle dispatch expands prompt templates so a slash payload
		 * reaches its real command handler; a busy session gets a follow-up instead of
		 * steering. A slash payload cannot be queued at all, so it waits for the turn to
		 * settle rather than being rewritten into plain text.
		 */
		async function dispatchTick(tick: LoopTick): Promise<void> {
			const active = requireScheduler();
			const entry = active.getState().entries[tick.loopId];
			if (entry === undefined || entry.phase === "ended") return;
			if (endedWithError.has(tick.loopId)) return;
			const currentCtx = ctx;
			if (currentCtx === undefined) return;

			const mode = modeOf(entry);
			const loopFile =
				entry.payload.type === "sentinel" ? await resolveLoopFileSafely(currentCtx) : { found: false as const };
			const built = buildTickMessage({
				loopId: entry.id,
				deliveryId: tick.deliveryId,
				mode,
				payload: entry.payload,
				reentryPrompt: entry.reentryPrompt,
				deliveryState: deliveryStateOf(entry.id),
				loopFile: loopFileSnapshot(loopFile),
			});
			deliveryStates.set(entry.id, built.deliveryState);

			const busy = !currentCtx.isIdle() || currentCtx.hasPendingMessages();
			if (busy && isExtensionCommandPayload(built.text)) {
				// Extension commands cannot be queued; hold this delivery until the turn settles.
				deferredDispatches.push(tick);
				return;
			}

			const noopStreak = entry.noopStreak;
			pi.appendEntry<LoopTickEntryData>(LOOP_TICK_ENTRY_TYPE, {
				loopId: entry.id,
				deliveryId: tick.deliveryId,
				scheduledForAt: tick.scheduledForAt,
				mode,
				delivery: built.delivery,
				...(built.details.sentinel === undefined ? {} : { sentinel: built.details.sentinel }),
				noopStreak,
				folded: noopStreak >= 2,
			});

			attributedLoopId = entry.id;
			attributedDeliveryId = tick.deliveryId;
			attributionResolved = false;
			pi.sendUserMessage(built.text, {
				expandPromptTemplates: true,
				...(busy ? { deliverAs: "followUp" as const } : {}),
			});
			await persist();
			refreshStatus();
		}

		async function resolveLoopFileSafely(currentCtx: ExtensionContext): Promise<LoopFileResult> {
			try {
				return await resolveLoopFile({ cwd: currentCtx.cwd, homeDir: homedir() });
			} catch {
				// A loop file that cannot be read is treated as absent for this tick; the loop
				// stays alive and picks the file up again once it is readable.
				return { found: false };
			}
		}

		async function drainDeferred(): Promise<void> {
			if (deferredDispatches.length === 0) return;
			const pending = deferredDispatches.splice(0, deferredDispatches.length);
			for (const tick of pending) await dispatchTick(tick);
		}

		async function fireDue(loopId: LoopId): Promise<void> {
			const active = scheduler;
			const currentCtx = ctx;
			if (active === undefined || currentCtx === undefined) return;
			const busy = !currentCtx.isIdle() || currentCtx.hasPendingMessages();
			const decision = active.onDue(loopId, clock.now(), busy);
			await persist();
			if (decision.action === "dispatch") {
				await dispatchTick(decision.tick);
				return;
			}
			if (decision.action === "expire") {
				ctx?.ui.notify("Loop expired after 7 days and is no longer armed.", "info");
			}
			refreshStatus();
		}

		/**
		 * Timer callbacks are synchronous, so the async due step is scheduled and its failure is
		 * contained: a rejected dispatch must never take down the timer that owns the loop.
		 */
		function handleTimerFire(loopId: LoopId): void {
			void fireDue(loopId).catch((error) => {
				ctx?.ui.notify(`Loop tick failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
		}

		function payloadForPrompt(prompt: string): LoopPayload {
			return { type: "prompt", prompt };
		}

		async function startFixed(request: StartFixedRequest): Promise<LoopCreateOutcome> {
			const active = requireScheduler();
			const effective = normalizeInterval(request.requestedInterval);
			const created = active.createFixed({
				originalArgs: request.originalArgs,
				reentryPrompt: `/loop ${request.originalArgs}`.trimEnd(),
				payload: payloadForPrompt(request.prompt),
				requestedInterval: request.requestedInterval,
				effectiveInterval: effective,
				cronExpression: describeCron(effective),
				intervalMs: effective.intervalMs,
			});
			if (!created.ok) return { ok: false, message: created.message };
			deliveryStates.set(created.loopId, emptyDeliveryState());
			await persist();
			nameSessionAfterLoop(request.prompt);
			await fireDue(created.loopId);
			refreshStatus();
			return {
				ok: true,
				loopId: created.loopId,
				...(effective.roundingNotice === undefined ? {} : { roundingNotice: effective.roundingNotice }),
				cronExpression: describeCron(effective),
				effectiveCadence: effective.human,
				expiresAt: active.getState().entries[created.loopId]?.expiresAt,
			};
		}

		async function startDynamic(request: StartDynamicRequest): Promise<LoopCreateOutcome> {
			const active = requireScheduler();
			const created = active.createDynamic({
				originalArgs: request.originalArgs,
				reentryPrompt: `/loop ${request.originalArgs}`.trimEnd(),
				payload: payloadForPrompt(request.prompt),
			});
			if (!created.ok) return { ok: false, message: created.message };
			deliveryStates.set(created.loopId, emptyDeliveryState());
			await persist();
			nameSessionAfterLoop(request.prompt);
			await fireDue(created.loopId);
			refreshStatus();
			return {
				ok: true,
				loopId: created.loopId,
				...(created.supersededLoopId === undefined ? {} : { supersededLoopId: created.supersededLoopId }),
				expiresAt: active.getState().entries[created.loopId]?.expiresAt,
			};
		}

		async function startBare(request: StartBareRequest): Promise<LoopCreateOutcome> {
			const active = requireScheduler();
			const currentCtx = ctx;
			if (currentCtx === undefined) return { ok: false, message: "loop extension has no active session" };
			const loopFile = await resolveLoopFileSafely(currentCtx);
			const mode: LoopMode = request.interval === undefined ? "dynamic" : "fixed";
			const payload: LoopPayload = { type: "sentinel", sentinel: sentinelFor(mode, loopFile.found) };
			const reentryPrompt = request.originalArgs.trim() === "" ? "/loop" : `/loop ${request.originalArgs.trim()}`;

			const created =
				request.interval === undefined
					? active.createDynamic({ originalArgs: request.originalArgs, reentryPrompt, payload })
					: (() => {
							const effective = normalizeInterval(request.interval);
							return active.createFixed({
								originalArgs: request.originalArgs,
								reentryPrompt,
								payload,
								requestedInterval: request.interval,
								effectiveInterval: effective,
								cronExpression: describeCron(effective),
								intervalMs: effective.intervalMs,
							});
						})();
			if (!created.ok) return { ok: false, message: created.message };
			deliveryStates.set(created.loopId, emptyDeliveryState());
			await persist();
			nameSessionAfterLoop(reentryPrompt);
			await fireDue(created.loopId);
			refreshStatus();
			return {
				ok: true,
				loopId: created.loopId,
				expiresAt: active.getState().entries[created.loopId]?.expiresAt,
			};
		}

		function nameSessionAfterLoop(prompt: string): void {
			if (sessionNamed) return;
			sessionNamed = true;
			if (pi.getSessionName() !== undefined) return;
			pi.setSessionName(`loop: ${prompt}`.trim());
		}

		const controller: LoopController = {
			startFixed,
			startDynamic,
			startBare,
			fireDue,
			scheduleWakeup: async (request) => {
				const active = requireScheduler();
				const result = active.onScheduleWakeup(request);
				if (result.ok) attributionResolved = true;
				await persist();
				refreshStatus();
			},
			stop: async (target, detail) => {
				const active = requireScheduler();
				const result = active.stop(target, detail);
				await persist();
				refreshStatus();
				return result.affectedLoopIds;
			},
			pause: async (target) => {
				const active = requireScheduler();
				const result = active.pause(target);
				await persist();
				refreshStatus();
				return result.affectedLoopIds;
			},
			resume: async (target) => {
				const active = requireScheduler();
				const result = active.resume(target);
				await persist();
				refreshStatus();
				return result.affectedLoopIds;
			},
			getState: () => requireScheduler().getState(),
			statusLine: () => formatLoopStatus(requireScheduler().getState(), clock.now()),
			lastStoreFailure: () => storeFailure,
			isEndedWithError: (loopId) => endedWithError.has(loopId),
		};

		deps.onControllerReady?.(controller);
		registerLoopCommand(pi, { controller });

		pi.on("session_start", async (_event, nextCtx) => {
			ctx = nextCtx;
			timers.cancelAll();
			timers = makeTimers();
			storeFailure = undefined;
			endedWithError.clear();
			storeTouched = false;
			sessionNamed = false;
			attributedLoopId = undefined;
			attributedDeliveryId = undefined;
			attributionResolved = false;
			deferredDispatches.length = 0;
			deliveryStates.clear();
			storeRef = storeRefOf(nextCtx);

			let initialState: LoopState | undefined;
			try {
				initialState = (await readState(storeRef)) ?? undefined;
			} catch (error) {
				// Fail closed: arm nothing, end nothing silently, and tell the user.
				failStore(error, []);
				scheduler = createLoopScheduler({
					sessionId: nextCtx.sessionManager.getSessionId(),
					clock,
					timers,
					ids,
					onFire: handleTimerFire,
				});
				return;
			}

			scheduler = createLoopScheduler({
				sessionId: nextCtx.sessionManager.getSessionId(),
				clock,
				timers,
				ids,
				onFire: handleTimerFire,
				...(initialState === undefined ? {} : { initialState }),
			});
			storeTouched = initialState !== undefined;

			for (const entry of Object.values(scheduler.getState().entries)) {
				const anchorDeliveryId = entry.sentinelDelivery.lastLoopFileDelivered?.anchorDeliveryId;
				const anchored = anchorPresent(nextCtx, entry.id, anchorDeliveryId);
				const needsFull = !anchored && hasAnchoredDelivery(entry.sentinelDelivery);
				deliveryStates.set(entry.id, {
					...entry.sentinelDelivery,
					forceFullDelivery: entry.sentinelDelivery.forceFullDelivery || needsFull,
				});
			}

			const restored = scheduler.restore(clock.now());
			await persist();
			refreshStatus();
			for (const tick of restored.recoveryTicks) await dispatchTick(tick);
			if (restored.expiredLoopIds.length > 0) {
				nextCtx.ui.notify(`Loop expired after 7 days: ${restored.expiredLoopIds.join(", ")}`, "info");
			}
		});

		pi.on("session_compact", async (event) => {
			// Accepted compaction may have dropped the anchor the reminders point at, so the
			// next sentinel tick must carry the full instructions again. Timers and phase are
			// deliberately untouched.
			if (event.accepted !== true) return;
			markForceFullDelivery();
			await persist();
		});

		pi.on("input", async (event) => {
			// A user turn is never an attributed loop iteration, so keepalive must not see it.
			// A tick dispatched by this extension arrives with source "extension" and MUST keep
			// its attribution, or no dynamic iteration would ever be judged.
			if (event.source === "extension") return;
			attributedLoopId = undefined;
			attributedDeliveryId = undefined;
			attributionResolved = false;
		});

		pi.on("agent_end", async (event) => {
			// A retrying turn is still in progress: neither settle it nor judge its liveness.
			if (event.willRetry === true) return;
			if (event.aborted === true && event.abortSource === "user") {
				await pauseAttributedLoop();
				return;
			}
			await settleAttributedTick(event.aborted === true ? "error" : "completed");
		});

		pi.on("agent_settled", async () => {
			await settleAttributedTick("completed");
			await drainDeferred();
			refreshStatus();
		});

		pi.on("session_abort", async () => {
			await pauseAttributedLoop();
		});

		pi.on("session_shutdown", async () => {
			const active = scheduler;
			if (active !== undefined) {
				// Shutdown SUSPENDS: every senpi shutdown reason leaves the session resumable,
				// so the snapshot must carry no terminal reason.
				active.onShutdown();
				await persist();
			}
			timers.cancelAll();
			deferredDispatches.length = 0;
			ticker.dispose();
			attributedLoopId = undefined;
			attributedDeliveryId = undefined;
			attributionResolved = false;
			ctx = undefined;
		});

		async function pauseAttributedLoop(): Promise<void> {
			const active = scheduler;
			if (active === undefined) return;
			const targets =
				attributedLoopId === undefined
					? Object.values(active.getState().entries)
							.filter((entry) => entry.phase !== "ended")
							.map((entry) => entry.id)
					: [attributedLoopId];
			const paused: LoopId[] = [];
			for (const loopId of targets) {
				if (active.onUserAbort(loopId).action === "paused") paused.push(loopId);
			}
			attributedLoopId = undefined;
			attributedDeliveryId = undefined;
			attributionResolved = false;
			if (paused.length === 0) return;
			await persist();
			refreshStatus();
			ctx?.ui.notify("loop paused - /loop resume or /loop stop", "info");
		}

		/**
		 * Settles the tick this turn was attributed to, drains a coalesced occurrence, and
		 * applies the two-strike keepalive to a dynamic iteration that ended without calling
		 * `schedule_wakeup`. An ordinary user turn clears the attribution first, so keepalive
		 * can never be charged to it, and a user abort takes the pause path instead.
		 */
		async function settleAttributedTick(outcome: "completed" | "error"): Promise<void> {
			const active = scheduler;
			const loopId = attributedLoopId;
			const deliveryId = attributedDeliveryId;
			if (active === undefined || loopId === undefined) return;
			const entry = active.getState().entries[loopId];
			if (entry === undefined) return;
			const resolved = attributionResolved;
			attributedLoopId = undefined;
			attributedDeliveryId = undefined;
			attributionResolved = false;

			const settled = deliveryId === undefined ? undefined : active.onTickSettled({ loopId, deliveryId, outcome });
			await persist();

			if (!resolved && entry.kind === "dynamic") {
				const keepalive = active.onTurnEndedWithoutSchedule(loopId);
				await persist();
				refreshStatus();
				if (keepalive.action === "ended") {
					ctx?.ui.notify(
						keepalive.endReason === "keepalive_exhausted"
							? "Loop ended: the model stopped scheduling wakeups."
							: "Loop expired after 7 days and is no longer armed.",
						"info",
					);
				}
				return;
			}

			if (settled?.action === "dispatch") {
				// Exactly one delivery drains a coalesced occurrence, however many were missed.
				await dispatchTick(settled.tick);
			} else if (settled?.action === "ended") {
				ctx?.ui.notify(`Loop ended: ${settled.endReason}.`, "info");
			}
			refreshStatus();
		}
	};
}

/** True when a reminder would refer back to a full delivery that must still exist. */
function hasAnchoredDelivery(state: SentinelDeliveryState): boolean {
	return state.autonomousPreambleDelivered || state.lastLoopFileDelivered !== null;
}

export default createLoopExtension();
