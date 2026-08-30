export interface TokenBudgetReminderState {
	lastFiredGeneration: number | null;
}

export interface TokenBudgetReminderInput {
	contextTokens: number;
	contextWindow: number;
	thresholdTokens: number;
	leadTokens: number;
	compactionGeneration: number;
	state: TokenBudgetReminderState;
}

export interface TokenBudgetReminderResult {
	message?: string;
	nextState: TokenBudgetReminderState;
}

export function createInitialReminderState(): TokenBudgetReminderState {
	return { lastFiredGeneration: null };
}

function formatReminderMessage(remaining: number): string {
	return `[context budget] Approximately ${remaining} tokens remain before automatic compaction. Wrap up verbose exploration, prefer concise summaries over full dumps, and front-load conclusions.`;
}

export function computeTokenBudgetReminder(input: TokenBudgetReminderInput): TokenBudgetReminderResult {
	const remaining = input.thresholdTokens - input.contextTokens;
	const inZone = remaining > 0 && remaining <= 2 * input.leadTokens;
	if (!inZone || input.state.lastFiredGeneration === input.compactionGeneration) {
		return { nextState: input.state };
	}
	return {
		message: formatReminderMessage(remaining),
		nextState: { lastFiredGeneration: input.compactionGeneration },
	};
}
