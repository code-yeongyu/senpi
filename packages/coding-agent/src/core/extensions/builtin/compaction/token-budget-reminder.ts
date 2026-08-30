export interface TokenBudgetReminderLease {
	compactionEpoch: number;
	message: string;
}

export interface TokenBudgetReminderState {
	lastFiredEpoch: number | null;
	lease?: TokenBudgetReminderLease;
}

export interface TokenBudgetReminderInput {
	contextTokens: number;
	contextWindow: number;
	thresholdTokens: number;
	leadTokens: number;
	compactionEpoch: number;
	state: TokenBudgetReminderState;
}

export interface TokenBudgetReminderResult {
	message?: string;
	nextState: TokenBudgetReminderState;
}

export function createInitialReminderState(): TokenBudgetReminderState {
	return { lastFiredEpoch: null };
}

function formatReminderMessage(remaining: number): string {
	return `[context budget] Approximately ${remaining} tokens remain before automatic compaction. Wrap up verbose exploration, prefer concise summaries over full dumps, and front-load conclusions.`;
}

export function clearTokenBudgetReminderLease(state: TokenBudgetReminderState): TokenBudgetReminderState {
	return state.lease ? { lastFiredEpoch: state.lastFiredEpoch } : state;
}

export function computeTokenBudgetReminder(input: TokenBudgetReminderInput): TokenBudgetReminderResult {
	const remaining = input.thresholdTokens - input.contextTokens;
	const inZone = remaining > 0 && remaining <= 2 * input.leadTokens;
	if (!inZone || input.state.lastFiredEpoch === input.compactionEpoch) {
		return { nextState: clearTokenBudgetReminderLease(input.state) };
	}
	const message = formatReminderMessage(remaining);
	return {
		message,
		nextState: {
			lastFiredEpoch: input.compactionEpoch,
			lease: { compactionEpoch: input.compactionEpoch, message },
		},
	};
}
