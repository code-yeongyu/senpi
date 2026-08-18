/**
 * Bounded retry policy for one extension-route summarization request.
 *
 * The core `compact()` route retries summarization through
 * `completeSummarization` (`core/compaction/compaction.ts`) with
 * `SettingsManager.getRetrySettings()`; the extension route had no retry, so a
 * transient 5xx ended the compaction on attempt one (observed 2026-08-12:
 * `500 Worker exceeded memory limit.`, `willRetry:false`, 28ms round trip).
 *
 * Retries are bounded by ELAPSED TIME as well as attempts. One attempt may hold
 * the session for `DEFAULT_SUMMARIZATION_MAX_DURATION_MS` (120s), so replaying a
 * slow failure would stack deadlines back to back - the freeze the wall-clock
 * budget exists to prevent. A fast upstream rejection leaves budget and is
 * retried; a failure that already burned the budget degrades as before.
 */
import type { RetryPolicy } from "@earendil-works/pi-ai";

export const MAX_SUMMARIZATION_ATTEMPT_RETRIES = 3;

/**
 * Total wall-clock all retried attempts of one summarization may consume.
 * Half of a single attempt's 120s budget: room for several fast upstream
 * rejections, never room to add another full deadline to the turn.
 */
export const SUMMARIZATION_RETRY_TOTAL_BUDGET_MS = 60_000;

/** Faster first retry than the provider default: this route blocks the turn. */
export const DEFAULT_SUMMARIZATION_RETRY_POLICY: RetryPolicy = {
	enabled: true,
	maxRetries: MAX_SUMMARIZATION_ATTEMPT_RETRIES,
	baseDelayMs: 1_000,
};

export function allowSummarizationRetry(elapsedMs: number): boolean {
	return elapsedMs < SUMMARIZATION_RETRY_TOTAL_BUDGET_MS;
}
