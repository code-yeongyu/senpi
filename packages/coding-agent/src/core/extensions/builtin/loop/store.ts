/**
 * Atomic, versioned, per-session sidecar store for `/loop` state.
 *
 * Mirrors the goal store's persistence discipline (temp file + rename, per-file mutation
 * serialization, strict versioned parsing) because scheduler state must never be half
 * written or silently reset: a corrupt file arms nothing and surfaces a typed error so
 * the extension can end affected loops with `error` instead of guessing.
 *
 * Session custom entries are deliberately NOT the authoritative store: they are branch
 * nodes, so a globally scanned "latest" entry can come from an abandoned branch, while
 * loop schedules are session-scoped.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type CronEntry,
	type DynamicCronEntry,
	EFFECTIVE_INTERVAL_UNITS,
	type EffectiveInterval,
	type EffectiveIntervalUnit,
	type EpochMs,
	type FixedCronEntry,
	isRecord,
	LOOP_END_REASONS,
	LOOP_PHASES,
	LOOP_SENTINELS,
	LOOP_STATE_VERSION,
	LOOP_WAKE_SOURCE_KINDS,
	type LoopEndReason,
	type LoopEntryFields,
	type LoopFileFingerprint,
	type LoopLifecycle,
	type LoopPayload,
	type LoopPhase,
	type LoopSentinel,
	type LoopState,
	type LoopStoreRef,
	type LoopWakeSource,
	type LoopWakeSourceKind,
	type PendingWakeup,
	REQUESTED_INTERVAL_UNITS,
	type RequestedInterval,
	type RequestedIntervalUnit,
	type SentinelDeliveryState,
} from "./types.ts";

export class InvalidLoopStoreError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "InvalidLoopStoreError";
	}
}

export class UnsupportedLoopStoreVersionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedLoopStoreVersionError";
	}
}

/** Mutation callback. May be async; its result becomes the next persisted state. */
export type LoopStateMutation = (current: LoopState) => LoopState | Promise<LoopState>;

const mutationTails = new Map<string, Promise<void>>();
const snapshots = new Map<string, LoopState>();

export function encodedSessionId(ref: LoopStoreRef): string {
	return encodeURIComponent(ref.sessionId);
}

export function loopStateFilePath(ref: LoopStoreRef): string {
	return join(ref.baseDir, `${encodedSessionId(ref)}.json`);
}

export function emptyLoopState(sessionId: string): LoopState {
	return { version: LOOP_STATE_VERSION, sessionId, entries: {}, activeDynamicId: null, updatedAt: 0 };
}

/**
 * Reads persisted state, or null when this session has never persisted any loop.
 * Throws {@link InvalidLoopStoreError} / {@link UnsupportedLoopStoreVersionError} on
 * unusable state so callers fail closed rather than resetting a user's schedule.
 */
export async function readLoopState(ref: LoopStoreRef): Promise<LoopState | null> {
	let raw: string;
	try {
		raw = await readFile(loopStateFilePath(ref), "utf8");
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return null;
		throw error;
	}
	const state = parseLoopState(raw, ref);
	snapshots.set(loopStateFilePath(ref), state);
	return state;
}

/** Like {@link readLoopState}, but returns an empty state when nothing is persisted. */
export async function loadLoopState(ref: LoopStoreRef): Promise<LoopState> {
	return (await readLoopState(ref)) ?? emptyLoopState(ref.sessionId);
}

/**
 * Last successfully loaded or written state for this ref, for synchronous consumers
 * (status line, tick attribution). Undefined until the store has been touched.
 */
export function snapshotLoopState(ref: LoopStoreRef): LoopState | undefined {
	return snapshots.get(loopStateFilePath(ref));
}

/**
 * Serializes read-modify-write cycles through a per-file promise tail so command,
 * timer, tool, and lifecycle writes cannot interleave and lose an update.
 */
export function mutateLoopState(ref: LoopStoreRef, mutation: LoopStateMutation): Promise<LoopState> {
	return enqueue(ref, async () => {
		const current = await loadLoopState(ref);
		const next = await mutation(current);
		await writeLoopState(ref, next);
		return next;
	});
}

/** Persists a complete state atomically. Prefer {@link mutateLoopState} for updates. */
export async function writeLoopState(ref: LoopStoreRef, state: LoopState): Promise<void> {
	const filePath = loopStateFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	await writeAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
	snapshots.set(filePath, state);
}

/** Drops cached snapshots; used when a session ends or tests reset global state. */
export function clearLoopStateSnapshot(ref: LoopStoreRef): void {
	snapshots.delete(loopStateFilePath(ref));
}

function enqueue<T>(ref: LoopStoreRef, operation: () => Promise<T>): Promise<T> {
	const key = loopStateFilePath(ref);
	const previous = mutationTails.get(key) ?? Promise.resolve();
	const run = previous.then(operation);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	mutationTails.set(key, tail);
	void tail.then(() => {
		if (mutationTails.get(key) === tail) mutationTails.delete(key);
	});
	return run;
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
	const tempPath = join(dirname(filePath), `.loop-${randomUUID()}.tmp`);
	try {
		await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, filePath);
	} catch (error) {
		try {
			await rm(tempPath, { force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"loop store write failed and its temporary file could not be removed",
			);
		}
		throw error;
	}
}

function parseLoopState(raw: string, ref: LoopStoreRef): LoopState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new InvalidLoopStoreError("loop store contains unparseable JSON", { cause: error });
	}
	if (!isRecord(parsed)) throw new InvalidLoopStoreError("loop store must be a JSON object");
	if (parsed.version !== LOOP_STATE_VERSION) {
		throw new UnsupportedLoopStoreVersionError(
			`unsupported loop store version: ${JSON.stringify(parsed.version)} (expected ${LOOP_STATE_VERSION})`,
		);
	}
	if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) {
		throw new InvalidLoopStoreError("loop store is missing a sessionId");
	}
	if (parsed.sessionId !== ref.sessionId) {
		throw new InvalidLoopStoreError(
			`loop store sessionId ${parsed.sessionId} does not match the session it was loaded for`,
		);
	}
	if (!isEpochMs(parsed.updatedAt)) throw new InvalidLoopStoreError("loop store has an invalid updatedAt");
	if (!isRecord(parsed.entries)) throw new InvalidLoopStoreError("loop store entries must be an object");

	const entries: Record<string, CronEntry> = {};
	for (const [id, value] of Object.entries(parsed.entries)) {
		const entry = parseEntry(id, value);
		entries[id] = entry;
	}

	const activeDynamicId = parsed.activeDynamicId;
	if (activeDynamicId !== null) {
		if (typeof activeDynamicId !== "string") {
			throw new InvalidLoopStoreError("loop store activeDynamicId must be a string or null");
		}
		const active = entries[activeDynamicId];
		if (active === undefined || active.kind !== "dynamic") {
			throw new InvalidLoopStoreError(`loop store activeDynamicId ${activeDynamicId} does not name a dynamic loop`);
		}
	}

	return {
		version: LOOP_STATE_VERSION,
		sessionId: parsed.sessionId,
		entries,
		activeDynamicId,
		updatedAt: parsed.updatedAt,
	};
}

function parseEntry(id: string, value: unknown): CronEntry {
	if (!isRecord(value)) throw new InvalidLoopStoreError(`loop entry ${id} is not an object`);
	if (value.id !== id) throw new InvalidLoopStoreError(`loop entry ${id} carries a mismatched id`);
	const kind = value.kind;
	if (kind !== "fixed" && kind !== "dynamic") throw new InvalidLoopStoreError(`loop entry ${id} has an unknown kind`);

	const base = parseEntryFields(id, value);
	if (kind === "fixed") {
		const fixed: FixedCronEntry = {
			...base,
			kind: "fixed",
			requestedInterval: parseRequestedInterval(id, value.requestedInterval),
			effectiveInterval: parseEffectiveInterval(id, value.effectiveInterval),
			cronExpression: requireString(id, "cronExpression", value.cronExpression),
			nextFireAt: requireEpochMs(id, "nextFireAt", value.nextFireAt),
			intervalMs: requirePositiveInteger(id, "intervalMs", value.intervalMs),
		};
		return fixed;
	}

	const keepaliveCredit = value.keepaliveCredit;
	if (keepaliveCredit !== 0 && keepaliveCredit !== 1) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid keepaliveCredit`);
	}
	const dynamic: DynamicCronEntry = {
		...base,
		kind: "dynamic",
		pendingWakeup: parsePendingWakeup(id, value.pendingWakeup),
		keepaliveCredit,
	};
	return dynamic;
}

function parseEntryFields(id: string, value: Record<string, unknown>): LoopEntryFields & LoopLifecycle {
	const fields = {
		id,
		originalArgs: requireString(id, "originalArgs", value.originalArgs, { allowEmpty: true }),
		reentryPrompt: requireString(id, "reentryPrompt", value.reentryPrompt),
		payload: parsePayload(id, value.payload),
		createdAt: requireEpochMs(id, "createdAt", value.createdAt),
		lastFiredAt: parseNullableEpochMs(id, "lastFiredAt", value.lastFiredAt),
		expiresAt: requireEpochMs(id, "expiresAt", value.expiresAt),
		lastScheduledForAt: parseNullableEpochMs(id, "lastScheduledForAt", value.lastScheduledForAt),
		coalescedFirePending: requireBoolean(id, "coalescedFirePending", value.coalescedFirePending),
		queuedForAt: parseNullableEpochMs(id, "queuedForAt", value.queuedForAt),
		noopStreak: requireNonNegativeInteger(id, "noopStreak", value.noopStreak),
		tickCount: requireNonNegativeInteger(id, "tickCount", value.tickCount),
		sentinelDelivery: parseSentinelDelivery(id, value.sentinelDelivery),
		wakeSources: parseWakeSources(id, value.wakeSources),
	};
	return { ...fields, ...parseLifecycle(id, value) };
}

type ParsedLifecycle =
	| { phase: Exclude<LoopPhase, "ended"> }
	| { phase: "ended"; endedAt: EpochMs; endReason: LoopEndReason; endDetail?: string };

function parseLifecycle(id: string, value: Record<string, unknown>): ParsedLifecycle {
	const phase = value.phase;
	if (typeof phase !== "string" || !isLoopPhase(phase)) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid phase`);
	}
	if (phase !== "ended") {
		if (value.endedAt !== undefined || value.endReason !== undefined || value.endDetail !== undefined) {
			throw new InvalidLoopStoreError(`loop entry ${id} carries terminal fields while not ended`);
		}
		return { phase };
	}
	const endReason = value.endReason;
	if (typeof endReason !== "string" || !isLoopEndReason(endReason)) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid endReason`);
	}
	const endDetail = value.endDetail;
	if (endDetail !== undefined && typeof endDetail !== "string") {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid endDetail`);
	}
	return {
		phase: "ended",
		endedAt: requireEpochMs(id, "endedAt", value.endedAt),
		endReason,
		...(endDetail === undefined ? {} : { endDetail }),
	};
}

function parsePayload(id: string, value: unknown): LoopPayload {
	if (!isRecord(value)) throw new InvalidLoopStoreError(`loop entry ${id} has an invalid payload`);
	if (value.type === "prompt") {
		return { type: "prompt", prompt: requireString(id, "payload.prompt", value.prompt) };
	}
	if (value.type === "sentinel") {
		const sentinel = value.sentinel;
		if (typeof sentinel !== "string" || !isLoopSentinel(sentinel)) {
			throw new InvalidLoopStoreError(`loop entry ${id} has an unknown payload sentinel`);
		}
		return { type: "sentinel", sentinel };
	}
	throw new InvalidLoopStoreError(`loop entry ${id} has an unknown payload type`);
}

function parseSentinelDelivery(id: string, value: unknown): SentinelDeliveryState {
	if (!isRecord(value)) throw new InvalidLoopStoreError(`loop entry ${id} has an invalid sentinelDelivery`);
	return {
		autonomousPreambleDelivered: requireBoolean(
			id,
			"sentinelDelivery.autonomousPreambleDelivered",
			value.autonomousPreambleDelivered,
		),
		lastLoopFileDelivered: parseFingerprint(id, value.lastLoopFileDelivered),
		forceFullDelivery: requireBoolean(id, "sentinelDelivery.forceFullDelivery", value.forceFullDelivery),
	};
}

function parseFingerprint(id: string, value: unknown): LoopFileFingerprint | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new InvalidLoopStoreError(`loop entry ${id} has an invalid loop-file fingerprint`);
	return {
		path: requireString(id, "fingerprint.path", value.path),
		mtimeMs: requireFiniteNumber(id, "fingerprint.mtimeMs", value.mtimeMs),
		size: requireNonNegativeInteger(id, "fingerprint.size", value.size),
		contentHash: requireString(id, "fingerprint.contentHash", value.contentHash),
		anchorDeliveryId: requireString(id, "fingerprint.anchorDeliveryId", value.anchorDeliveryId),
	};
}

function parseWakeSources(id: string, value: unknown): readonly LoopWakeSource[] {
	if (!Array.isArray(value)) throw new InvalidLoopStoreError(`loop entry ${id} has invalid wakeSources`);
	return value.map((candidate): LoopWakeSource => {
		if (!isRecord(candidate)) throw new InvalidLoopStoreError(`loop entry ${id} has an invalid wake source`);
		const source = candidate.source;
		if (typeof source !== "string" || !isWakeSourceKind(source)) {
			throw new InvalidLoopStoreError(`loop entry ${id} has an unknown wake source kind`);
		}
		const description = candidate.description;
		if (description !== undefined && typeof description !== "string") {
			throw new InvalidLoopStoreError(`loop entry ${id} has an invalid wake source description`);
		}
		return {
			source,
			id: requireString(id, "wakeSource.id", candidate.id),
			createdAt: requireEpochMs(id, "wakeSource.createdAt", candidate.createdAt),
			...(description === undefined ? {} : { description }),
		};
	});
}

function parsePendingWakeup(id: string, value: unknown): PendingWakeup | null {
	if (value === null || value === undefined) return null;
	if (!isRecord(value)) throw new InvalidLoopStoreError(`loop entry ${id} has an invalid pendingWakeup`);
	const source = value.source;
	if (source !== "model" && source !== "keepalive") {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid pendingWakeup source`);
	}
	if (value.kind !== "dynamic") throw new InvalidLoopStoreError(`loop entry ${id} has an invalid pendingWakeup kind`);
	return {
		id: requireString(id, "pendingWakeup.id", value.id),
		loopId: requireString(id, "pendingWakeup.loopId", value.loopId),
		kind: "dynamic",
		source,
		requestedDelaySeconds: requireFiniteNumber(
			id,
			"pendingWakeup.requestedDelaySeconds",
			value.requestedDelaySeconds,
		),
		delaySeconds: requirePositiveInteger(id, "pendingWakeup.delaySeconds", value.delaySeconds),
		dueAt: requireEpochMs(id, "pendingWakeup.dueAt", value.dueAt),
		reason: requireString(id, "pendingWakeup.reason", value.reason),
		prompt: requireString(id, "pendingWakeup.prompt", value.prompt),
		noop: requireBoolean(id, "pendingWakeup.noop", value.noop),
		createdAt: requireEpochMs(id, "pendingWakeup.createdAt", value.createdAt),
	};
}

function parseRequestedInterval(id: string, value: unknown): RequestedInterval {
	if (!isRecord(value)) throw new InvalidLoopStoreError(`loop entry ${id} has an invalid requestedInterval`);
	const unit = value.unit;
	if (typeof unit !== "string" || !isRequestedIntervalUnit(unit)) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid requestedInterval unit`);
	}
	return {
		value: requirePositiveInteger(id, "requestedInterval.value", value.value),
		unit,
		raw: requireString(id, "requestedInterval.raw", value.raw),
	};
}

function parseEffectiveInterval(id: string, value: unknown): EffectiveInterval {
	if (!isRecord(value)) throw new InvalidLoopStoreError(`loop entry ${id} has an invalid effectiveInterval`);
	const unit = value.unit;
	if (typeof unit !== "string" || !isEffectiveIntervalUnit(unit)) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid effectiveInterval unit`);
	}
	const roundingNotice = value.roundingNotice;
	if (roundingNotice !== undefined && typeof roundingNotice !== "string") {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid effectiveInterval roundingNotice`);
	}
	return {
		value: requirePositiveInteger(id, "effectiveInterval.value", value.value),
		unit,
		human: requireString(id, "effectiveInterval.human", value.human),
		rounded: requireBoolean(id, "effectiveInterval.rounded", value.rounded),
		...(roundingNotice === undefined ? {} : { roundingNotice }),
	};
}

function requireString(id: string, field: string, value: unknown, options?: { allowEmpty?: boolean }): string {
	if (typeof value !== "string" || (options?.allowEmpty !== true && value.length === 0)) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid ${field}`);
	}
	return value;
}

function requireBoolean(id: string, field: string, value: unknown): boolean {
	if (typeof value !== "boolean") throw new InvalidLoopStoreError(`loop entry ${id} has an invalid ${field}`);
	return value;
}

function requireFiniteNumber(id: string, field: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid ${field}`);
	}
	return value;
}

function requireNonNegativeInteger(id: string, field: string, value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid ${field}`);
	}
	return value as number;
}

function requirePositiveInteger(id: string, field: string, value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new InvalidLoopStoreError(`loop entry ${id} has an invalid ${field}`);
	}
	return value as number;
}

function requireEpochMs(id: string, field: string, value: unknown): EpochMs {
	if (!isEpochMs(value)) throw new InvalidLoopStoreError(`loop entry ${id} has an invalid ${field}`);
	return value;
}

function parseNullableEpochMs(id: string, field: string, value: unknown): EpochMs | null {
	if (value === null || value === undefined) return null;
	return requireEpochMs(id, field, value);
}

function isEpochMs(value: unknown): value is EpochMs {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isLoopPhase(value: string): value is LoopPhase {
	return (LOOP_PHASES as readonly string[]).includes(value);
}

function isLoopEndReason(value: string): value is LoopEndReason {
	return (LOOP_END_REASONS as readonly string[]).includes(value);
}

function isLoopSentinel(value: string): value is LoopSentinel {
	return (LOOP_SENTINELS as readonly string[]).includes(value);
}

function isWakeSourceKind(value: string): value is LoopWakeSourceKind {
	return (LOOP_WAKE_SOURCE_KINDS as readonly string[]).includes(value);
}

function isRequestedIntervalUnit(value: string): value is RequestedIntervalUnit {
	return (REQUESTED_INTERVAL_UNITS as readonly string[]).includes(value);
}

function isEffectiveIntervalUnit(value: string): value is EffectiveIntervalUnit {
	return (EFFECTIVE_INTERVAL_UNITS as readonly string[]).includes(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
