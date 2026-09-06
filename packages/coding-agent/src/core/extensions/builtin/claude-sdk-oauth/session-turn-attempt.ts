import { BoundedAsyncQueue, SESSION_STREAM_QUEUE_CAPACITY } from "./bounded-queue.ts";
import { sdkResultFailure } from "./errors.ts";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import { bindingFromEntry, forgetBinding, rememberBinding } from "./session-reattach.ts";
import {
	type ClaudeSdkOauthSessionEntry,
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
			} catch (error) {
				// The queue failed (completion rejected: pump failure, query end,
				// attribution error). The payload was still pushed, so the retry needs
				// the same checkpoint the aborted path records.
				if (error instanceof Error && RESUME_TARGET_MISSING.test(error.message)) {
					resumeTargetMissing = true;
					forgetBinding(entry.senpiSessionId);
				} else {
					rememberRetryCheckpoint(entry, hashes);
				}
				throw error;
			} finally {
				staged.emit();
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
