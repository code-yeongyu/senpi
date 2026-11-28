import {
	type AssistantMessage,
	isClassifierRefusal,
	isContextOverflow,
	isProviderTimeoutError,
	isRetryableAssistantError,
} from "@earendil-works/pi-ai/compat";
import { fallbackClassificationText } from "./retry-fallback/classification-text.ts";
import { isModelConfigFailure } from "./retry-fallback/model-config-error.ts";

/** Providers mark post-delta failures with this prefix so a turn retry never replays visible text or tool calls. */
export const TURN_RETRY_SUPPRESSION_PREFIX = "senpi:no-turn-retry:";

/**
 * Failures the turn retry never takes, whatever their text says: a suppressed replay, a local (journal or file)
 * failure, a route that does not serve the model, and a context overflow, which compaction handles.
 */
export function isExcludedFromTurnRetry(message: AssistantMessage, contextWindow: number): boolean {
	if (message.errorMessage?.startsWith(TURN_RETRY_SUPPRESSION_PREFIX)) return true;
	if (message.failureSource === "local") return true;
	if (isModelConfigFailure(message)) return true;
	return isContextOverflow(message, contextWindow);
}

/**
 * The turn retry engine's own transient-failure decision (overloaded, rate limit, server errors). The interactive
 * transcript reads the same predicate, so a row is folded into the retry episode only for a failure the engine retries
 * (senpi#6012).
 */
export function isTurnRetryableFailure(message: AssistantMessage, contextWindow: number): boolean {
	const text = fallbackClassificationText(message.errorMessage);
	const failure = text === message.errorMessage ? message : { ...message, errorMessage: text };
	if (isExcludedFromTurnRetry(failure, contextWindow)) return false;
	if (isClassifierRefusal(failure)) return true;
	if (!text) return false;
	if (failure.stopReason === "aborted") return isProviderTimeoutError(failure);
	return isRetryableAssistantError(failure);
}
