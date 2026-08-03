/**
 * Classifies a summarization failure as transient (degrade quietly through the
 * compaction failure path) or terminal (surface loudly).
 *
 * Transient failures must not escape as extension errors: the runner would print
 * a raw stack on top of the `compaction_end` message the user already saw, while
 * the turn's own provider request surfaces the same outage again through the
 * normal retry path.
 *
 * Provider `error` stops carry metadata-aware classification through
 * `SummaryRequestError` (a refusal whose text merely looks retryable stays
 * loud). Watchdog trips — a stalled stream or a stream that outlived its
 * wall-clock budget — are infrastructure-slowness outcomes and always degrade.
 * Everything else falls back to the shared message classifier.
 */
import { isRetryableErrorMessage } from "@earendil-works/pi-ai";
import { StreamDurationBudgetError, StreamIdleTimeoutError } from "../../../compaction/stream-watchdog.ts";
import { SummarizationOverflowExhaustedError } from "./overflow-retry.ts";
import { SummaryRequestError } from "./speculative.ts";

export function isTransientSummarizationFailure(error: unknown, message: string): boolean {
	if (error instanceof StreamDurationBudgetError || error instanceof StreamIdleTimeoutError) return true;
	if (error instanceof SummaryRequestError) return error.transient;
	if (error instanceof SummarizationOverflowExhaustedError) return true;
	return isRetryableErrorMessage(message);
}
