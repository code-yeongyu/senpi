import type { HistoryReducer } from "../../../session-history-reduce.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";

export const GOAL_STOP_PAUSED_ENTRY = "goal-stop-paused";
export const GOAL_STOP_RESUMED_ENTRY = "goal-stop-resumed";

type Marker = { goalId: string };

export function stopHoldLive(ctx: ExtensionContext): boolean {
	return (
		ctx.getPauseState?.().holds.some((hold) => hold.kind === "session_hold" && hold.key !== "interrupted-run") ===
		true
	);
}

export function markStopPaused(pi: Pick<ExtensionAPI, "appendEntry">, goalId: string): void {
	pi.appendEntry<Marker>(GOAL_STOP_PAUSED_ENTRY, { goalId });
}

export function markStopResumed(pi: Pick<ExtensionAPI, "appendEntry">, goalId: string): void {
	pi.appendEntry<Marker>(GOAL_STOP_RESUMED_ENTRY, { goalId });
}

/** Whether the user's Stop paused each goal, read without keeping a full-history view (senpi#2537). */
const stopPausedGoals: HistoryReducer<Map<string, boolean>> = {
	initial: () => new Map(),
	add: (goals, entry) => {
		if (entry.type !== "custom") return goals;
		const goalId = (entry.data as Partial<Marker> | undefined)?.goalId;
		if (typeof goalId !== "string") return goals;
		if (entry.customType === GOAL_STOP_PAUSED_ENTRY) goals.set(goalId, true);
		else if (entry.customType === GOAL_STOP_RESUMED_ENTRY) goals.set(goalId, false);
		return goals;
	},
};

/** A goal the user's Stop paused (not `/goal pause`) resumes with the session (senpi#3811). */
export function pausedByStop(ctx: ExtensionContext, goalId: string): boolean {
	return ctx.sessionManager.reduceHistory(stopPausedGoals).get(goalId) === true;
}
