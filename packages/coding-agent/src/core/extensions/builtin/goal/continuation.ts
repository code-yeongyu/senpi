import type { Goal } from "./types.ts";

export function shouldQueueGoalContinuationWhenIdle(
	goal: Goal | null,
	isIdle: boolean,
	hasPendingMessages: boolean,
): goal is Goal {
	return goal?.status === "active" && isIdle && !hasPendingMessages;
}

export function shouldQueueGoalContinuationAfterAgentEnd(goal: Goal | null, hasPendingMessages: boolean): goal is Goal {
	return goal?.status === "active" && !hasPendingMessages;
}
