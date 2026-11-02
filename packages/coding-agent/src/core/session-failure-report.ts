import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/**
 * Providers only cache a prompt prefix above a model-specific minimum size, so a
 * zero cache read on a small prompt is not evidence of a lost cache. The report
 * uses one fixed threshold of 2,048 prompt tokens for every provider; smaller
 * prompts are never counted as full misses.
 */
export const MIN_CACHEABLE_PROMPT_TOKENS = 2048;

/** What provider failures cost a session: every provider response is one request. */
export interface SessionFailureReport {
	requests: number;
	erroredRequests: number;
	abortedRequests: number;
	failureShare: number;
	/** Wall time from each failed request's start to its recorded end. */
	failedDurationMs: number;
	/**
	 * Retries that succeeded after a failure: the first successful response after
	 * one or more failed requests within the same user turn (no user message in
	 * between), whichever chain entry answered.
	 */
	postFailureRequests: number;
	/** Those retries that read nothing from the prompt cache on a prompt of at least MIN_CACHEABLE_PROMPT_TOKENS. */
	postFailureFullMissRequests: number;
	/**
	 * Uncached prompt tokens (input + cache writes) of those retries: what the retry
	 * sent without a cache hit. The provider's usage report is exact; attributing the
	 * miss to the failure is the report's reading of the sequence, not a provider fact.
	 */
	postFailureFullMissInputTokens: number;
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & { message: AssistantMessage } {
	return entry.type === "message" && entry.message.role === "assistant";
}

function requestDurationMs(recordedAt: string, startedAt: number): number {
	const endedAt = Date.parse(recordedAt);
	return Number.isFinite(endedAt) && Number.isFinite(startedAt) && endedAt > startedAt ? endedAt - startedAt : 0;
}

export function computeSessionFailureReport(entries: readonly SessionEntry[]): SessionFailureReport {
	let requests = 0;
	let erroredRequests = 0;
	let abortedRequests = 0;
	let failedDurationMs = 0;
	let postFailureRequests = 0;
	let postFailureFullMissRequests = 0;
	let postFailureFullMissInputTokens = 0;
	let previousFailed = false;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			previousFailed = false;
			continue;
		}
		if (!isAssistantEntry(entry)) continue;
		const { message } = entry;
		requests++;
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		if (failed) {
			if (message.stopReason === "error") erroredRequests++;
			else abortedRequests++;
			failedDurationMs += requestDurationMs(entry.timestamp, message.timestamp);
		} else if (previousFailed) {
			postFailureRequests++;
			const uncachedTokens = message.usage.input + message.usage.cacheWrite;
			if (message.usage.cacheRead === 0 && uncachedTokens >= MIN_CACHEABLE_PROMPT_TOKENS) {
				postFailureFullMissRequests++;
				postFailureFullMissInputTokens += uncachedTokens;
			}
		}
		previousFailed = failed;
	}
	return {
		requests,
		erroredRequests,
		abortedRequests,
		failureShare: requests > 0 ? (erroredRequests + abortedRequests) / requests : 0,
		failedDurationMs,
		postFailureRequests,
		postFailureFullMissRequests,
		postFailureFullMissInputTokens,
	};
}
