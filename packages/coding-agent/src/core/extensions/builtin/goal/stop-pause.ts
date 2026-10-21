import type { ExtensionAPI, ExtensionContext } from "../../types.ts";

export const GOAL_STOP_PAUSED_ENTRY = "goal-stop-paused";
export const GOAL_STOP_RESUMED_ENTRY = "goal-stop-resumed";

type Marker = { goalId: string };

export function stopHoldLive(ctx: ExtensionContext): boolean {
	return ctx.getPauseState?.().holds.some((hold) => hold.kind === "session_hold") === true;
}

export function markStopPaused(pi: Pick<ExtensionAPI, "appendEntry">, goalId: string): void {
	pi.appendEntry<Marker>(GOAL_STOP_PAUSED_ENTRY, { goalId });
}

export function markStopResumed(pi: Pick<ExtensionAPI, "appendEntry">, goalId: string): void {
	pi.appendEntry<Marker>(GOAL_STOP_RESUMED_ENTRY, { goalId });
}

/** A goal the user's Stop paused (not `/goal pause`) resumes with the session (senpi#3811). */
export function pausedByStop(ctx: ExtensionContext, goalId: string): boolean {
	let paused = false;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || (entry.data as Partial<Marker> | undefined)?.goalId !== goalId) continue;
		if (entry.customType === GOAL_STOP_PAUSED_ENTRY) paused = true;
		else if (entry.customType === GOAL_STOP_RESUMED_ENTRY) paused = false;
	}
	return paused;
}
