import { BoundedAsyncQueue, SESSION_STREAM_QUEUE_CAPACITY } from "./bounded-queue.ts";
import { sdkResultFailure } from "./errors.ts";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import type { ContinuityMetrics } from "./session-observability.ts";
import { bindingFromEntry, forgetBinding, rememberBinding } from "./session-reattach.ts";
import {
	type ClaudeSdkOauthSessionEntry,
	closeSession,
	isCurrentGeneration,
	sessionRegistry,
} from "./session-registry.ts";
import { submitSessionTurn } from "./session-registry-pump.ts";
import { recordSyncedStream, sentHashPrefixDigest } from "./session-sync.ts";

type StagedContinuityDecision = { emit(metrics?: ContinuityMetrics): void };

type SuccessfulSdkResult = Extract<SDKMessage, { type: "result"; subtype: "success" }>;

function lastSuccessfulResult(messages: readonly SDKMessage[]): SuccessfulSdkResult | undefined {
	let last: SuccessfulSdkResult | undefined;
	for (const message of messages) {
		if (message.type === "result" && message.subtype === "success" && sdkResultFailure(message) === undefined) {
			last = message;
		}
	}
	return last;
}

function successfulTurn(messages: readonly SDKMessage[]): boolean {
	return lastSuccessfulResult(messages) !== undefined;
}

/**
 * The retained attempt's cache/token cost, read from its last successful
 * result: absent fields were not reported (an absent value is never a measured
 * zero), so they stay undefined rather than being zero-filled (senpi#1976).
 */
function attemptContinuityMetrics(messages: readonly SDKMessage[]): ContinuityMetrics | undefined {
	const result = lastSuccessfulResult(messages);
	if (result === undefined) return undefined;
	const metrics: ContinuityMetrics = {};
	// The SDK types usage as always present; an older CLI can still omit the
	// whole object, so treat it as partial and let absent fields stay undefined.
	const usage: Partial<SuccessfulSdkResult["usage"]> | undefined = result.usage;
	if (typeof usage?.cache_read_input_tokens === "number") metrics.cacheRead = usage.cache_read_input_tokens;
	if (typeof usage?.cache_creation_input_tokens === "number") {
		metrics.cacheWrite = usage.cache_creation_input_tokens;
	}
	if (typeof usage?.input_tokens === "number") metrics.inputTokens = usage.input_tokens;
	if (typeof result.num_turns === "number") metrics.numTurns = result.num_turns;
	return metrics;
}

function recordAssistantUuid(entry: ClaudeSdkOauthSessionEntry, sentCount: number, message: SDKMessage): void {
	if (message.type === "assistant" && message.parent_tool_use_id === null) {
		entry.assistantUuidByIndex.set(sentCount, message.uuid);
	}
}

/**
 * An attempt that pushed its user payload and then aborted or failed leaves that
 * message on the lineage un-answered: `recordSyncedStream` never ran, so the
 * entry still points at the PRE-TURN boundary. Remembering the binding at that
 * boundary, tagged with the attempted turn's full sent-stream digest, lets the
 * SAME turn's retry fork past the orphaned message instead of appending it
 * twice (issue #723 retry storm). In-memory only — nothing here is persisted.
 */
/** Claude Code answered "No conversation found with session ID": the bound id is dead, never resume it again. */
const RESUME_TARGET_MISSING = /no conversation found with session id/i;

/** Claude Code's wording for a fork point absent from its transcript; the captured id is the dead one. */
const RESUME_MESSAGE_MISSING = /no message found with message\.uuid(?:\s+of)?:\s*([0-9a-fA-F-]+)/i;

/**
 * Drops only the boundary Claude Code rejected. Republishing it would make the next admission ask
 * for the same dead id, fail the same way, and flatten again (senpi#1958); earlier boundaries stay
 * mapped so the retry can still fork at one of them instead of re-sending the conversation.
 */
function forgetMissingAssistantUuid(entry: ClaudeSdkOauthSessionEntry, message: string): void {
	const missing = RESUME_MESSAGE_MISSING.exec(message)?.[1];
	if (missing === undefined) return;
	for (const [index, uuid] of entry.assistantUuidByIndex) {
		if (uuid === missing) entry.assistantUuidByIndex.delete(index);
	}
}

function publishBinding(entry: ClaudeSdkOauthSessionEntry, binding: Parameters<typeof rememberBinding>[0]): void {
	rememberBinding({ ...binding, sdkSessionIdConfirmed: entry.sdkSessionIdConfirmed });
}

function rememberRetryCheckpoint(entry: ClaudeSdkOauthSessionEntry, hashes: readonly string[]): void {
	if (entry.sentCount < 0 || entry.sentCount > hashes.length) return;
	publishBinding(entry, {
		...bindingFromEntry(entry, hashes.slice(0, entry.sentCount)),
		unansweredTurnDigest: sentHashPrefixDigest(hashes, hashes.length),
	});
}

export function createSessionTurnAttempt(
	entry: ClaudeSdkOauthSessionEntry,
	message: SDKUserMessage["message"],
	hashes: readonly string[],
	signal: AbortSignal | undefined,
	staged: StagedContinuityDecision,
) {
	const generation = entry.generation;
	// Claude Code declared the bound id dead: no later cleanup may re-publish it.
	let resumeTargetMissing = false;
	return {
		messages: (async function* (): AsyncGenerator<SDKMessage> {
			const queue = new BoundedAsyncQueue<SDKMessage>(SESSION_STREAM_QUEUE_CAPACITY);
			const completion = submitSessionTurn(sessionRegistry, entry, {
				message,
				signal,
				onMessage: (sdkMessage) => {
					recordAssistantUuid(entry, hashes.length, sdkMessage);
					queue.push(sdkMessage);
				},
			});
			void completion.then(
				() => queue.close(),
				(error: unknown) => queue.fail(error),
			);
			try {
				for await (const sdkMessage of queue) yield sdkMessage;
				const turn = await completion;
				if (!turn.aborted && successfulTurn(turn.messages)) {
					recordSyncedStream(entry, hashes);
					publishBinding(entry, bindingFromEntry(entry, hashes));
				} else {
					rememberRetryCheckpoint(entry, hashes);
				}
				// Emit only when this attempt was consumed to completion (retained). A
				// discarded attempt (failover to another account) unwinds through the
				// generator's return() and never reaches here; an internally-failed
				// attempt throws to the catch below. Both stay silent so the turn yields
				// exactly one continuity observation - this retained attempt, or the
				// single terminal observation residentSessionMessages emits when every
				// attempt fails. The retained attempt's result usage rides along
				// (senpi#1976); a turn without a successful result passes undefined.
				staged.emit(attemptContinuityMetrics(turn.messages));
			} catch (error) {
				// The queue failed (completion rejected: pump failure, query end,
				// attribution error). The payload was still pushed, so the retry needs
				// the same checkpoint the aborted path records.
				if (error instanceof Error && RESUME_TARGET_MISSING.test(error.message)) {
					resumeTargetMissing = true;
					forgetBinding(entry.senpiSessionId);
				} else {
					if (error instanceof Error) forgetMissingAssistantUuid(entry, error.message);
					rememberRetryCheckpoint(entry, hashes);
				}
				throw error;
			}
		})(),
		discard: (): void => {
			if (resumeTargetMissing) forgetBinding(entry.senpiSessionId);
			else rememberRetryCheckpoint(entry, hashes);
			if (isCurrentGeneration(entry.senpiSessionId, generation)) {
				closeSession(entry.senpiSessionId, "attempt_discarded");
			}
		},
	};
}
