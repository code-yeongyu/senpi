import type { Api, Context, Model } from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

export const CONTEXT_SAFETY_TOKENS = 4096;
/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;
const MIN_MAX_TOKENS = 1;
/** Windows too small to hold the safety margin plus one answer keep the legacy one-token floor. */
export const CONTEXT_GUARD_MIN_WINDOW = CONTEXT_SAFETY_TOKENS + MIN_ANSWER_TOKENS;

export class ContextWindowExhaustedError extends Error {
	readonly estimatedTokens: number;
	readonly contextWindow: number;

	constructor(estimatedTokens: number, contextWindow: number) {
		super(
			`Context window exhausted: the conversation is estimated at ${estimatedTokens} of ${contextWindow} tokens, ` +
				`leaving fewer than ${MIN_ANSWER_TOKENS} tokens for a response. ` +
				"Compact the conversation, enable auto-compaction, or start a new session before retrying.",
		);
		this.name = "ContextWindowExhaustedError";
		this.estimatedTokens = estimatedTokens;
		this.contextWindow = contextWindow;
	}
}

/**
 * Fit the requested output budget into the room the context leaves in the model window.
 * For windows of at least {@link CONTEXT_GUARD_MIN_WINDOW} tokens this throws
 * {@link ContextWindowExhaustedError} instead of shrinking the budget below
 * {@link MIN_ANSWER_TOKENS}: such a request can only return a truncated tool call or an
 * empty "length" stop while still billing the whole prompt.
 */
export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number): number {
	if (model.contextWindow <= 0) {
		return Number.isFinite(maxTokens) && maxTokens > 0
			? Math.max(MIN_MAX_TOKENS, Math.floor(maxTokens))
			: MIN_MAX_TOKENS;
	}
	const estimatedTokens = estimateContextTokens(context).tokens;
	const available = model.contextWindow - estimatedTokens - CONTEXT_SAFETY_TOKENS;
	if (model.contextWindow >= CONTEXT_GUARD_MIN_WINDOW && available < MIN_ANSWER_TOKENS) {
		throw new ContextWindowExhaustedError(estimatedTokens, model.contextWindow);
	}
	const safeAvailable = Math.max(MIN_MAX_TOKENS, available);
	const requested = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : safeAvailable;
	return Math.min(requested, safeAvailable);
}
