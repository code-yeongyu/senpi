import type { ExtensionContext } from "../../types.ts";
import { formatGoalElapsedSeconds } from "./format.ts";
import type { Goal } from "./types.ts";

export const STATUS_KEY = "goal";

const OBJECTIVE_PREVIEW_MAX_LENGTH = 32;

export function truncateGoalObjective(objective: string, maxLength = OBJECTIVE_PREVIEW_MAX_LENGTH): string {
	const normalized = objective.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}

export function updateGoalUi(ctx: ExtensionContext, goal: Goal | null, liveElapsedSeconds?: number): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, goal === null ? undefined : goalStatusText(goal, liveElapsedSeconds));
}

export function goalStatusText(goal: Goal, liveElapsedSeconds?: number): string {
	switch (goal.status) {
		case "active": {
			if (liveElapsedSeconds !== undefined) {
				return `Pursuing goal (${formatGoalElapsedSeconds(liveElapsedSeconds)})`;
			}
			return goal.timeUsedSeconds > 0
				? `Pursuing goal (${formatGoalElapsedSeconds(goal.timeUsedSeconds)})`
				: "Pursuing goal";
		}
		case "paused":
			return "Goal paused (/goal resume)";
		case "blocked":
			return goal.blockedReason ? `Goal blocked: ${goal.blockedReason}` : "Goal blocked";
		case "complete": {
			const elapsed = goal.timeUsedSeconds > 0 ? ` (${formatGoalElapsedSeconds(goal.timeUsedSeconds)})` : "";
			return `${truncateGoalObjective(goal.objective)} \u00b7 Goal achieved${elapsed}`;
		}
	}
}
