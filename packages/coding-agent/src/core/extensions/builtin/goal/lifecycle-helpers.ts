import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { shouldQueueGoalContinuationWhenIdle } from "./continuation.ts";
import { buildContinuationPrompt } from "./prompt.ts";
import type { Goal } from "./types.ts";

const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";

export function isResumeOfPausedGoal(
	ctx: ExtensionContext,
	sessionStartReason: string,
	goal: Goal | null,
): goal is Goal {
	return (
		sessionStartReason === "resume" &&
		goal?.status === "paused" &&
		ctx.hasUI &&
		ctx.isIdle() &&
		!ctx.hasPendingMessages()
	);
}

export function queueGoalContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: Goal): void {
	if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
		queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
	}
}

export function queueHiddenGoalPrompt(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{ customType: GOAL_CONTINUATION_MESSAGE_TYPE, content, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
