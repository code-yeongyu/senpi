import type { Goal, GoalStatus } from "../../../core/extensions/builtin/goal/types.ts";
import type { ThreadGoal } from "../protocol/generated/v2/ThreadGoal.ts";

const GOAL_STATUS_TO_THREAD_STATUS = {
	active: "active",
	paused: "paused",
	complete: "complete",
} as const satisfies Record<GoalStatus, ThreadGoal["status"]>;

/** Convert the budget-behavior-free builtin goal, including inert compatibility metadata, to Codex's wire shape. */
export function toThreadGoal(goal: Goal): ThreadGoal {
	return {
		threadId: goal.threadId,
		objective: goal.objective,
		status: GOAL_STATUS_TO_THREAD_STATUS[goal.status],
		tokenBudget: goal.tokenBudget ?? null,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
	};
}
