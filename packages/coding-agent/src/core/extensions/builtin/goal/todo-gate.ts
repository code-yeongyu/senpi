import type { SessionEntry } from "../../../session-manager.ts";
import { getLatestPhasesFromBranchEntries, isIncompleteTodo, isTodoPhaseArray } from "../todotools/state.ts";
import type { Goal } from "./types.ts";
import { isRecord } from "./types.ts";

const MAX_LISTED_TASKS = 5;

/**
 * Contents of every non-terminal (pending / in_progress) task in the thread's
 * latest todo list. The goal builtin refuses to mark a goal complete while any
 * of these remain: an open todo task is remaining work by definition.
 */
export function openTodoTaskContents(entries: SessionEntry[]): string[] {
	return getLatestPhasesFromBranchEntries(entries)
		.flatMap((phase) => phase.tasks)
		.filter(isIncompleteTodo)
		.map((task) => task.content);
}

export function openTodoCompletionError(openTasks: readonly string[]): string {
	const listed = openTasks
		.slice(0, MAX_LISTED_TASKS)
		.map((task) => `"${task}"`)
		.join(", ");
	const suffix = openTasks.length > MAX_LISTED_TASKS ? ` and ${openTasks.length - MAX_LISTED_TASKS} more` : "";
	return (
		`cannot mark the goal complete: ${openTasks.length} open todo task(s) remain: ${listed}${suffix}. ` +
		"Do the remaining work, or drop the tasks that are genuinely no longer needed - closing an unfinished task " +
		"to clear this gate reports a completion that did not happen. Then run the completion audit again and retry update_goal."
	);
}

/**
 * True when a successful todo tool result came from an add operation (init /
 * append) that left at least one open (pending / in_progress) task behind.
 */
export function todoResultAddsOpenTasks(details: unknown): boolean {
	if (!isRecord(details)) return false;
	const op = details.op;
	if (op !== "init" && op !== "append") return false;
	const phases = details.phases;
	if (!isTodoPhaseArray(phases)) return false;
	return phases.some((phase) => phase.tasks.some(isIncompleteTodo));
}

/**
 * System reminder injected into a todo tool result when new open tasks were
 * added while the thread has no goal, or only a stale (already complete) one.
 * The mirror of the completion gate above: newly tracked work should be
 * anchored to a live goal when it serves a durable objective.
 */
export function staleGoalTodoReminder(goal: Goal | null): string | undefined {
	if (goal !== null && goal.status !== "complete") return undefined;
	const staleLine =
		goal === null
			? "New todo tasks were added, but this thread has no goal registered."
			: "New todo tasks were added, but the registered goal is already complete (stale), so the new work is untracked.";
	const fixLine =
		goal === null
			? "If this todo list tracks a durable objective (multi-step work that should survive across turns), register it now with create_goal so progress is tracked and audited."
			: "If this todo list tracks a durable objective (multi-step work that should survive across turns), register it now with create_goal; creating a new goal archives the completed one and replaces it.";
	return [
		"<system-reminder>",
		staleLine,
		fixLine,
		"If the todos are trivial short-lived bookkeeping for the current turn, continue without a goal.",
		"</system-reminder>",
	].join("\n");
}
