import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import { evaluateAbortOutcome } from "./session-reattach.ts";
import {
	type ClaudeSdkOauthSessionEntry,
	type ClaudeSdkOauthSessionRegistry,
	createSessionUuid,
} from "./session-registry.ts";
import {
	transitionToIdleSynced,
	transitionToTurnResultSeen,
	transitionToTurnSent,
	transitionToTurnStreaming,
	transitionToTurnWaiting,
} from "./session-registry-state.ts";
import { bufferBeforeReplay, claimTurn, deliver, isReplayFor, resultMatchesTurn } from "./session-turn-claim.ts";
import type { ActiveTurn, PreReplayBufferLimits, SessionTurnResult } from "./session-turn-types.ts";

export type { SessionTurnResult } from "./session-turn-types.ts";

import { SessionTurnAttributionError } from "./session-turn-types.ts";

export const DEFAULT_PRE_REPLAY_MAX_MESSAGES = 64;
export const DEFAULT_PRE_REPLAY_MAX_BYTES = 256 * 1024;
export const SESSION_TURN_ABORT_GRACE_MS = 1_000;

export interface SessionTurnRequest {
	message: SDKUserMessage["message"];
	signal?: AbortSignal;
	onMessage?: (message: SDKMessage) => void;
	scheduleAbort?: (callback: () => void, delayMs: number) => () => void;
}

export class ConcurrentSessionTurnAdmissionError extends Error {
	readonly code = "claude_sdk_oauth_concurrent_turn_admission";

	constructor(sessionId: string) {
		super(`Concurrent Claude SDK OAuth turn admission for session ${sessionId}`);
		this.name = "ConcurrentSessionTurnAdmissionError";
	}
}

function currentTurn(entry: ClaudeSdkOauthSessionEntry): ActiveTurn | null {
	return entry.activeTurn as ActiveTurn | null;
}

function scheduleAbort(callback: () => void, delayMs: number): () => void {
	const timer = setTimeout(callback, delayMs);
	timer.unref();
	return () => clearTimeout(timer);
}

function removeAbortListener(turn: ActiveTurn): void {
	turn.signal?.removeEventListener("abort", turn.onAbort);
	turn.cancelAbort?.();
	turn.cancelAbort = undefined;
}

function failTurn(registry: ClaudeSdkOauthSessionRegistry, entry: ClaudeSdkOauthSessionEntry, error: Error): void {
	const turn = currentTurn(entry);
	if (turn) {
		removeAbortListener(turn);
		entry.activeTurn = null;
		turn.reject(error);
	}
	if (registry.isCurrentGeneration(entry.senpiSessionId, entry.generation)) {
		registry.closeSession(entry.senpiSessionId, error.message);
	}
}

/**
 * An interrupt that never produces a terminal result still ends the user's turn:
 * settle it as aborted and close only the query, so the binding survives and the
 * next turn reattaches. Rejecting here would drop the turn's continuity
 * observation and hand the following turn two.
 */
function abortTurn(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	turn: ActiveTurn,
	_error: Error,
): void {
	if (currentTurn(entry) !== turn || !registry.isCurrentGeneration(entry.senpiSessionId, turn.generation)) return;
	removeAbortListener(turn);
	entry.activeTurn = null;
	registry.closeSession(entry.senpiSessionId, "abort_uncertain");
	turn.resolve({ uuid: turn.uuid, messages: turn.messages, aborted: true });
}

function finishTurn(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	turn: ActiveTurn,
	message: Extract<SDKMessage, { type: "result" }>,
): void {
	if (!resultMatchesTurn(message, turn)) {
		throw new SessionTurnAttributionError("Claude SDK OAuth result user_message_uuid did not match the active turn");
	}
	if (entry.state === "TURN_CLAIMED") transitionToTurnStreaming(entry);
	if (!turn.aborted) deliver(entry, turn, message);
	transitionToTurnResultSeen(entry);
	removeAbortListener(turn);
	entry.activeTurn = null;
	if (!turn.aborted || evaluateAbortOutcome(turn.interruptReceipt) === "keep") transitionToIdleSynced(entry);
	else registry.closeSession(entry.senpiSessionId, "abort_uncertain");
	turn.resolve({ uuid: turn.uuid, messages: turn.messages, aborted: turn.aborted });
}

function handleMessage(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	message: SDKMessage,
): void {
	// A forked query mints a NEW session id (forkSession: true + resume): the
	// init message carries it, and it must be persisted BEFORE any turn-state
	// guard — otherwise subsequent reattach targets the original session and
	// the fork's content is lost.
	if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
		if (message.session_id !== entry.sdkSessionId) entry.sdkSessionId = message.session_id;
	}
	const turn = currentTurn(entry);
	if (!turn || !registry.isCurrentGeneration(entry.senpiSessionId, turn.generation)) return;
	if (!turn.claimed) {
		if (isReplayFor(message, turn.uuid)) claimTurn(entry, turn);
		else if (message.type === "stream_event") bufferBeforeReplay(registry, entry, turn, message);
		else if (message.type === "result") {
			throw new SessionTurnAttributionError("Claude SDK OAuth result arrived before replay claim");
		}
		return;
	}
	if (message.type === "user" && "isReplay" in message && message.isReplay === true) return;
	if (message.type === "result") finishTurn(registry, entry, turn, message);
	else deliver(entry, turn, message);
}

async function runPump(registry: ClaudeSdkOauthSessionRegistry, entry: ClaudeSdkOauthSessionEntry): Promise<void> {
	const iterator = entry.query[Symbol.asyncIterator]();
	try {
		while (true) {
			const { value, done } = await iterator.next();
			if (done) {
				failTurn(registry, entry, new Error("Claude SDK OAuth query ended before the active turn completed"));
				return;
			}
			handleMessage(registry, entry, value);
		}
	} catch (error) {
		failTurn(registry, entry, error instanceof Error ? error : new Error(String(error)));
	}
}

export function submitSessionTurn(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	request: SessionTurnRequest,
	limits: PreReplayBufferLimits = {
		maxMessages: DEFAULT_PRE_REPLAY_MAX_MESSAGES,
		maxBytes: DEFAULT_PRE_REPLAY_MAX_BYTES,
	},
): Promise<SessionTurnResult> {
	if (currentTurn(entry)) throw new ConcurrentSessionTurnAdmissionError(entry.senpiSessionId);
	if (entry.state === "STARTING") transitionToIdleSynced(entry);
	transitionToTurnWaiting(entry);
	const uuid = createSessionUuid();
	let turn!: ActiveTurn;
	const promise = new Promise<SessionTurnResult>((resolve, reject) => {
		const onAbort = (): void => {
			if (turn.aborted) return;
			turn.aborted = true;
			turn.cancelAbort = (request.scheduleAbort ?? scheduleAbort)(
				() => abortTurn(registry, entry, turn, new Error("Claude SDK OAuth interrupted turn did not terminate")),
				SESSION_TURN_ABORT_GRACE_MS,
			);
			void entry.query
				.interrupt()
				.then((receipt: unknown) => {
					turn.interruptReceipt = receipt;
				})
				.catch((error: unknown) => {
					const detail = error instanceof Error ? error.message : String(error);
					abortTurn(registry, entry, turn, new Error(`Claude SDK OAuth query interrupt failed: ${detail}`));
				});
		};
		turn = {
			uuid,
			generation: entry.generation,
			messages: [],
			preReplay: [],
			preReplayBytes: 0,
			claimed: false,
			aborted: false,
			onMessage: request.onMessage,
			signal: request.signal,
			onAbort,
			resolve,
			reject,
			limits,
		};
	});
	entry.activeTurn = turn;
	if (!entry.pumpTask) entry.pumpTask = runPump(registry, entry);
	entry.inputController.push({
		type: "user",
		message: request.message,
		parent_tool_use_id: null,
		uuid,
		session_id: entry.sdkSessionId,
	});
	transitionToTurnSent(entry);
	if (request.signal?.aborted) turn.onAbort();
	else request.signal?.addEventListener("abort", turn.onAbort, { once: true });
	return promise;
}
