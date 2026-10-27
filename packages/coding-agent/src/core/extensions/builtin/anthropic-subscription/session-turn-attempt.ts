import { BoundedAsyncQueue, SESSION_STREAM_QUEUE_CAPACITY } from "./bounded-queue.ts";
import { sdkResultFailure } from "./errors.ts";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import { bindingFromEntry, type ContinuityBinding, forgetBinding, rememberBinding } from "./session-reattach.ts";
import {
	type AnthropicSubscriptionSessionEntry,
	closeSession,
	isCurrentGeneration,
	sessionRegistry,
} from "./session-registry.ts";
import { submitSessionTurn } from "./session-registry-pump.ts";
import { recordSyncedStream, sentHashPrefixDigest } from "./session-sync.ts";

type StagedContinuityDecision = { emit(): void };

function successfulTurn(messages: readonly SDKMessage[]): boolean {
	return messages.some(
		(message) =>
			message.type === "result" && message.subtype === "success" && sdkResultFailure(message) === undefined,
	);
}

function recordAssistantUuid(entry: AnthropicSubscriptionSessionEntry, sentCount: number, message: SDKMessage): void {
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
export const RESUME_MESSAGE_MISSING = /no message found with message\.uuid(?:\s+of)?:\s*([0-9a-fA-F-]+)/i;

/**
 * Drops only the boundary Claude Code rejected. Republishing it would make the next admission ask
 * for the same dead id, fail the same way, and flatten again (senpi#1958); earlier boundaries stay
 * mapped so the retry can still fork at one of them instead of re-sending the conversation.
 */
function forgetMissingAssistantUuid(entry: AnthropicSubscriptionSessionEntry, message: string): void {
	const missing = RESUME_MESSAGE_MISSING.exec(message)?.[1];
	if (missing === undefined) return;
	for (const [index, uuid] of entry.assistantUuidByIndex) {
		if (uuid === missing) entry.assistantUuidByIndex.delete(index);
	}
}

/** The same drop on a lineage this attempt forked from: the boundary was missing from that lineage's transcript. */
function withoutMissingAssistantUuid(binding: ContinuityBinding, message: string): ContinuityBinding {
	const missing = RESUME_MESSAGE_MISSING.exec(message)?.[1];
	if (missing === undefined) return binding;
	return {
		...binding,
		lastAssistantUuid: binding.lastAssistantUuid === missing ? null : binding.lastAssistantUuid,
		assistantUuidByIndex: binding.assistantUuidByIndex?.filter(([, uuid]) => uuid !== missing),
	};
}

function publishBinding(
	entry: AnthropicSubscriptionSessionEntry,
	binding: Parameters<typeof rememberBinding>[0],
): void {
	rememberBinding({ ...binding, sdkSessionIdConfirmed: entry.sdkSessionIdConfirmed });
}

function rememberRetryCheckpoint(entry: AnthropicSubscriptionSessionEntry, hashes: readonly string[]): void {
	if (entry.sentCount < 0 || entry.sentCount > hashes.length) return;
	publishBinding(entry, {
		...bindingFromEntry(entry, hashes.slice(0, entry.sentCount)),
		unansweredTurnDigest: sentHashPrefixDigest(hashes, hashes.length),
	});
}

/**
 * An unanswered attempt on an account other than the one `servedLineage` names served nothing, so the
 * session's prompt cache is most likely still on that account. Once the attempt's process is gone,
 * `servedLineage` stays the binding, so the next request prefers its account, forks its own lineage
 * there and reads its cache, and is not reported as a seat change (senpi#4304). An attempt on that same
 * account records its own retry checkpoint, as before. `servedLineage` is the last binding recorded for
 * the session, not proof of the last answer: see `createSessionTurnAttempt`.
 */
function rememberUnansweredAttempt(
	entry: AnthropicSubscriptionSessionEntry,
	hashes: readonly string[],
	servedLineage: ContinuityBinding | undefined,
): void {
	if (servedLineage !== undefined && servedLineage.accountName !== entry.accountName) rememberBinding(servedLineage);
	else rememberRetryCheckpoint(entry, hashes);
}

export function createSessionTurnAttempt(
	entry: AnthropicSubscriptionSessionEntry,
	message: SDKUserMessage["message"],
	hashes: readonly string[],
	signal: AbortSignal | undefined,
	staged: StagedContinuityDecision,
	/**
	 * The binding this process held for the session before this attempt (`getBinding`). It is the last
	 * binding recorded, which usually names the account that last answered, but not always: a retry
	 * checkpoint from an unanswered attempt, the entry kept when a session closes, a resumed lineage and
	 * a binding restored from the session file on restart are recorded the same way, so it can name an
	 * account whose latest attempt went unanswered. Undefined when nothing has been recorded since the
	 * session started, forked or lost its binding (for example on compaction or divergence).
	 */
	servedLineage?: ContinuityBinding,
) {
	const generation = entry.generation;
	// Claude Code declared the bound id dead: no later cleanup may re-publish it.
	let resumeTargetMissing = false;
	let servedBefore = servedLineage;
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
				writable: () => queue.writable(),
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
				} else if (isCurrentGeneration(entry.senpiSessionId, generation)) {
					// A process kept after a clean interrupt still holds this turn: the binding stays on its lineage,
					// which the live entry keeps serving.
					rememberRetryCheckpoint(entry, hashes);
				} else {
					rememberUnansweredAttempt(entry, hashes, servedBefore);
				}
				// Emit only when this attempt was consumed to completion (retained). A
				// discarded attempt (failover to another account) unwinds through the
				// generator's return() and never reaches here; an internally-failed
				// attempt throws to the catch below. Both stay silent so the turn yields
				// exactly one continuity observation - this retained attempt, or the
				// single terminal observation residentSessionMessages emits when every
				// attempt fails.
				staged.emit();
			} catch (error) {
				// The queue failed (completion rejected: pump failure, query end,
				// attribution error). The payload was still pushed, so the retry needs
				// the same checkpoint the aborted path records.
				if (error instanceof Error && RESUME_TARGET_MISSING.test(error.message)) {
					resumeTargetMissing = true;
					forgetBinding(entry.senpiSessionId);
				} else {
					if (error instanceof Error) {
						forgetMissingAssistantUuid(entry, error.message);
						if (servedBefore) servedBefore = withoutMissingAssistantUuid(servedBefore, error.message);
					}
					rememberUnansweredAttempt(entry, hashes, servedBefore);
				}
				throw error;
			} finally {
				// A consumer that stops reading early must not leave the pump waiting for room.
				queue.close();
			}
		})(),
		discard: (): void => {
			if (resumeTargetMissing) forgetBinding(entry.senpiSessionId);
			else rememberUnansweredAttempt(entry, hashes, servedBefore);
			if (isCurrentGeneration(entry.senpiSessionId, generation)) {
				closeSession(entry.senpiSessionId, "attempt_discarded");
			}
		},
	};
}
