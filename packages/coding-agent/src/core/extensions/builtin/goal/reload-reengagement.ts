import type { ExtensionContext } from "../../types.ts";
import { GOAL_CONTINUATION_CAP } from "./continuation.ts";
import type { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
import type { Goal } from "./types.ts";

export type ReloadReengagementOutcome =
	| "skipped-inactive"
	| "backstop-rearmed"
	| "suppressed-flood"
	| "continuation-queued";

/**
 * Re-engages a goal after a config reload retired the previous extension
 * generation. Reload disposes every armed continuation timer with the old
 * generation, so without this the goal would park until the next user message.
 *
 * The 2026-07-27 contract (a reload must not auto-start an agent the user
 * stopped) is preserved through goal status: every user stop marks the goal
 * blocked via `session_abort` / `agent_end` abortSource "user", and the
 * continuation evaluator denies non-active goals, so only genuinely active
 * goals are re-engaged here.
 *
 * A goal with live wake sources keeps waiting on them: the terminal builtin
 * replays its monitor snapshots before this handler runs (builtin order is
 * load-bearing), so the monitor-delayed backstop is re-armed instead of
 * queueing an immediate continuation. Without wake sources the goal resumes
 * through the same sessionStart admission as startup/resume, including the
 * trailing-flood suppression.
 */
export async function reengageGoalAfterReload(options: {
	readonly ctx: ExtensionContext;
	readonly goal: Goal;
	readonly monitor: MonitorAwareGoalContinuation;
	readonly countTrailingContinuations: () => number;
	readonly queueContinuation: () => Promise<void>;
}): Promise<ReloadReengagementOutcome> {
	const { ctx, goal, monitor } = options;
	if (goal.status !== "active") return "skipped-inactive";
	if (monitor.hasActiveWakeSources()) {
		monitor.rearmMonitorBackstop(goal);
		return "backstop-rearmed";
	}
	const trailingContinuations = options.countTrailingContinuations();
	if (trailingContinuations >= GOAL_CONTINUATION_CAP) {
		ctx.ui.notify(
			`Goal auto-continuation suppressed for this resumed session (${trailingContinuations} historical continuations). Send a message to resume.`,
			"info",
		);
		return "suppressed-flood";
	}
	await options.queueContinuation();
	return "continuation-queued";
}
