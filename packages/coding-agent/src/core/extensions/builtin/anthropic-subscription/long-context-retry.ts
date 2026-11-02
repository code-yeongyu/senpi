import { classifySdkError, type SdkErrorClassification, sdkAssistantFailure, sdkResultFailure } from "./errors.ts";
import { markLongContextRefused } from "./long-context.ts";
import { refusalError } from "./refusal.ts";
import type { SDKMessage } from "./sdk-boundary.ts";

export function sdkFailure(message: SDKMessage): unknown | undefined {
	const refusal = refusalError(message);
	if (refusal) return refusal;
	if (message.type === "assistant") return sdkAssistantFailure(message);
	if (message.type === "result") return sdkResultFailure(message);
	return undefined;
}

export function visibleSdkMessage(message: SDKMessage): boolean {
	if (message.type !== "stream_event") return false;
	return /^(?:content_block_start|content_block_delta|content_block_stop)$/.test(message.event.type);
}

/**
 * Only a request that asked for the legacy `[1m]` window can have that window refused. The same words
 * on any other request (a native-1M model, which never sends the legacy beta) are an ordinary failure:
 * never a recorded refusal, a 200k retry, or a rate limit that blocks the account (senpi#3801).
 */
export function classifyForRequest(error: unknown, askedLegacyLongContext: boolean): SdkErrorClassification {
	const classification = classifySdkError(error);
	return classification.kind === "long_context_unavailable" && !askedLegacyLongContext
		? { kind: "other", retryable: false }
		: classification;
}

/**
 * The ambient lane has no account failover, so a refused 1M window is retried here: once, and only
 * before anything visible streamed. Messages pass through as they arrive (system/init, api_retry and
 * refusals keep their order and timing); the refused attempt is closed before the retry starts, after
 * the refusal is recorded so the rebuilt options ask for the standard window (senpi#3408).
 */
export async function* retryAtStandardWindowOnce(
	attempt: () => Promise<AsyncIterable<SDKMessage>>,
	askedLegacyLongContext: () => boolean,
): AsyncGenerator<SDKMessage> {
	const first = (await attempt())[Symbol.asyncIterator]();
	let refused = false;
	let finished = false;
	try {
		let visible = false;
		for (;;) {
			const next = await first.next();
			if (next.done) {
				finished = true;
				return;
			}
			const failure = visible ? undefined : sdkFailure(next.value);
			if (
				failure !== undefined &&
				classifyForRequest(failure, askedLegacyLongContext()).kind === "long_context_unavailable"
			) {
				refused = true;
				break;
			}
			visible ||= visibleSdkMessage(next.value);
			yield next.value;
		}
	} finally {
		// Closes the first query on every exit (refusal, consumer return, error) before any retry spawns.
		if (!finished) {
			try {
				await first.return?.();
			} catch {
				// Closing the first query must never replace the error (or the refusal) that ended it.
			}
		}
	}
	if (!refused) return;
	markLongContextRefused();
	yield* await attempt();
}
