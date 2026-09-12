import { CONTEXT_SAFETY_TOKENS, MIN_ANSWER_TOKENS } from "../api/context-room.ts";

interface PrefillBudget {
	readonly requested: number | null | undefined;
	readonly thinkingTokens: number;
	readonly signal?: AbortSignal;
}

/** OpenGateway's prefill rejection reports all four counts, including the actual wire completion cap. */
const PREFILL_COUNTS =
	/Prefill server error \(400 Bad Request\): .*Requested token count exceeds the model's maximum context length of (\d+) tokens\. You requested a total of (\d+) tokens: (\d+) tokens from the input messages and (\d+) tokens for the completion\./;

/** Preserve the existing safety/answer reserve and reasoning budget; ambiguous reports remain errors. */
export function repairedOutputBudget(error: unknown, budget: PrefillBudget): number | undefined {
	if (!(error instanceof Error) || budget.signal?.aborted) return undefined;
	const match = PREFILL_COUNTS.exec(error.message);
	if (!match) return undefined;
	const [window, total, input, completion] = match.slice(1).map(Number);
	if (![window, total, input, completion].every((value) => Number.isSafeInteger(value) && value > 0)) {
		return undefined;
	}
	if (completion !== budget.requested || input + completion !== total || total <= window) return undefined;
	const available = window - input - CONTEXT_SAFETY_TOKENS;
	if (available < MIN_ANSWER_TOKENS + budget.thinkingTokens || available >= completion) return undefined;
	return available;
}
