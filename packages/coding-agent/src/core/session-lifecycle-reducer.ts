import type {
	ChildLifecycleReport,
	LifecycleHold,
	LifecycleWaits,
	SessionLifecycle,
	SessionLifecycleState,
} from "./session-lifecycle-types.ts";

export interface LifecycleFacts {
	readonly role: "root" | "child";
	readonly terminal?: ChildLifecycleReport["terminal"];
	readonly holds: readonly LifecycleHold[];
	readonly waits: LifecycleWaits;
	readonly running: boolean;
	readonly failure?: SessionLifecycle["failure"];
}

/** Approved first-match precedence; no turn-end verdict label is an input. */
export function lifecycleState(facts: LifecycleFacts): SessionLifecycleState {
	const stopHeld = facts.holds.some((hold) => hold.kind === "session_hold" || hold.kind === "inherited_hold");
	if (facts.role === "child" && facts.terminal !== undefined) {
		switch (facts.terminal) {
			case "completed":
				if (facts.holds.length === 0) return "done";
				break;
			case "cancelled":
				return "cancelled";
			case "error":
			case "lost":
				return "failed";
			case "interrupted":
				if (!stopHeld) return "failed";
				break;
			default:
				return facts.terminal satisfies never;
		}
	}
	if (stopHeld) return "paused";
	if (facts.holds.some((hold) => hold.kind === "run_fence") && !facts.running) return "paused";
	if (facts.holds.length > 0 && facts.holds.every((hold) => hold.kind === "unattended")) return "held";
	if (facts.waits.human.length > 0) return "waiting_human";
	if (facts.running) return "running";
	if (facts.waits.children > 0) return "waiting_children";
	if (facts.waits.background.length > 0) return "waiting_background";
	// The task record, not the child's local idle, owns its terminal outcome.
	if (facts.role === "child") return "running";
	if (facts.failure !== undefined) return "failed";
	return "done";
}

export function lifecycleTerminal(state: SessionLifecycleState): boolean {
	switch (state) {
		case "done":
		case "failed":
		case "cancelled":
			return true;
		case "running":
		case "waiting_children":
		case "waiting_background":
		case "waiting_human":
		case "paused":
		case "held":
			return false;
		default:
			return state satisfies never;
	}
}
