import { summarizationHistoryBudget, SUMMARIZATION_INPUT_BUDGET_RATIO } from "./overflow-retry.ts";

/**
 * Whether a summary request's fixed part (the session system prompt it carries plus the summary instructions) leaves
 * a model room for history inside its input budget (oh-my-openagent#9698). `summarizationHistoryBudget` floors the
 * history budget at a minimum, so a fixed part past the input budget would otherwise still be sent, and a side model
 * with a small window rejects every speculative request.
 */
export function summaryRequestFits(contextWindow: number, fixedTokens: number): boolean {
	const inputBudget = Math.floor(contextWindow * SUMMARIZATION_INPUT_BUDGET_RATIO);
	return fixedTokens + summarizationHistoryBudget(contextWindow, fixedTokens) <= inputBudget;
}
