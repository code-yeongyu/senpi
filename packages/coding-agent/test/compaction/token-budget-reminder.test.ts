import { describe, expect, it } from "vitest";
import {
	clearTokenBudgetReminderLease,
	computeTokenBudgetReminder,
	createInitialReminderState,
	type TokenBudgetReminderState,
} from "../../src/core/extensions/builtin/compaction/token-budget-reminder.ts";

const THRESHOLD_TOKENS = 10_000;
const LEAD_TOKENS = 500;
const CONTEXT_WINDOW = 32_000;
const IN_ZONE_REMAINING = LEAD_TOKENS;
const IN_ZONE_CONTEXT_TOKENS = THRESHOLD_TOKENS - IN_ZONE_REMAINING;

function expectedMessage(remaining: number): string {
	return `[context budget] Approximately ${remaining} tokens remain before automatic compaction. Wrap up verbose exploration, prefer concise summaries over full dumps, and front-load conclusions.`;
}

function reminder(
	overrides: Partial<{
		contextTokens: number;
		contextWindow: number;
		thresholdTokens: number;
		leadTokens: number;
		compactionEpoch: number;
		state: TokenBudgetReminderState;
	}> = {},
) {
	return computeTokenBudgetReminder({
		contextTokens: IN_ZONE_CONTEXT_TOKENS,
		contextWindow: CONTEXT_WINDOW,
		thresholdTokens: THRESHOLD_TOKENS,
		leadTokens: LEAD_TOKENS,
		compactionEpoch: 1,
		state: createInitialReminderState(),
		...overrides,
	});
}

describe("createInitialReminderState", () => {
	it("starts with no fired epoch", () => {
		expect(createInitialReminderState()).toEqual({ lastFiredEpoch: null });
	});
});

describe("computeTokenBudgetReminder", () => {
	it("fires in-zone once", () => {
		const result = reminder();
		expect(result.message).toBe(expectedMessage(IN_ZONE_REMAINING));
		expect(result.nextState).toEqual({
			lastFiredEpoch: 1,
			lease: { compactionEpoch: 1, message: expectedMessage(IN_ZONE_REMAINING) },
		});
	});

	it("fires at the inclusive upper bound of the reminder zone", () => {
		const remaining = 2 * LEAD_TOKENS;
		const result = reminder({ contextTokens: THRESHOLD_TOKENS - remaining });
		expect(result.message).toBe(expectedMessage(remaining));
		expect(result.nextState).toEqual({
			lastFiredEpoch: 1,
			lease: { compactionEpoch: 1, message: expectedMessage(remaining) },
		});
	});

	it("does not refire for the same epoch", () => {
		const state: TokenBudgetReminderState = { lastFiredEpoch: 1 };
		const result = reminder({ state, compactionEpoch: 1 });
		expect(result.message).toBeUndefined();
		expect(result.nextState).toBe(state);
	});

	it("refires after the accepted-compaction epoch increments", () => {
		const state: TokenBudgetReminderState = { lastFiredEpoch: 1 };
		const result = reminder({ state, compactionEpoch: 2 });
		expect(result.message).toBe(expectedMessage(IN_ZONE_REMAINING));
		expect(result.nextState).toEqual({
			lastFiredEpoch: 2,
			lease: { compactionEpoch: 2, message: expectedMessage(IN_ZONE_REMAINING) },
		});
		expect(result.nextState).not.toBe(state);
	});

	it("clears the active lease when the same epoch reaches the next user turn", () => {
		const lease = { compactionEpoch: 1, message: expectedMessage(IN_ZONE_REMAINING) };
		const result = reminder({ state: { lastFiredEpoch: 1, lease } });
		expect(result.message).toBeUndefined();
		expect(result.nextState).toEqual({ lastFiredEpoch: 1 });
	});

	it("clears the active lease when reminders are disabled", () => {
		const lease = { compactionEpoch: 1, message: expectedMessage(IN_ZONE_REMAINING) };
		expect(clearTokenBudgetReminderLease({ lastFiredEpoch: 1, lease })).toEqual({ lastFiredEpoch: 1 });
	});

	it("does not fire above the reminder zone", () => {
		const state = createInitialReminderState();
		const result = reminder({
			state,
			contextTokens: THRESHOLD_TOKENS - (2 * LEAD_TOKENS + 1),
		});
		expect(result.message).toBeUndefined();
		expect(result.nextState).toBe(state);
	});

	it("does not fire at or past the threshold", () => {
		const state = createInitialReminderState();
		const atThreshold = reminder({ state, contextTokens: THRESHOLD_TOKENS });
		const pastThreshold = reminder({ state, contextTokens: THRESHOLD_TOKENS + 1 });
		expect(atThreshold.message).toBeUndefined();
		expect(atThreshold.nextState).toBe(state);
		expect(pastThreshold.message).toBeUndefined();
		expect(pastThreshold.nextState).toBe(state);
	});

	it("returns the same state object when nothing changes", () => {
		const state: TokenBudgetReminderState = { lastFiredEpoch: 3 };
		const result = reminder({
			state,
			compactionEpoch: 3,
			contextTokens: IN_ZONE_CONTEXT_TOKENS,
		});
		expect(result).toEqual({ nextState: state });
		expect(result.nextState).toBe(state);
	});
});
