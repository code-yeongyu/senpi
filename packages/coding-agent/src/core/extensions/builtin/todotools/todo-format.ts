// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { stripAnsi } from "../../../../utils/ansi.ts";
import { nextActionableTask } from "./todo-query.ts";
import type { TodoAsk, TodoItem, TodoPhase } from "./todo-types.ts";

export type AskNowNext = { ask: string; now: string; next: string };

/**
 * The three handoff anchors of a todo state: the captured user request, the task in
 * progress, and the first pending task after it in phase order (it may sit in an earlier
 * phase after an out-of-order start). Task labels are verbatim.
 */
export function describeAskNowNext(state: { phases: readonly TodoPhase[]; ask?: TodoAsk }): AskNowNext {
	const ask = state.ask?.text ?? "(no user request captured)";
	const located = state.phases.flatMap((phase) => phase.tasks.map((task) => ({ task, phase: phase.name })));
	if (located.length === 0) return { ask, now: "none - no todo list", next: "none" };
	const nowTask = nextActionableTask(state.phases);
	const now = located.find((hit) => hit.task === nowTask);
	const next = located.find((hit) => hit.task.status === "pending" && hit.task !== nowTask);
	return {
		ask,
		now: now ? `${now.task.content} (${now.phase})` : "none - all tasks closed",
		next: next ? `${next.task.content} (${next.phase})` : "none",
	};
}

/** The todo transitions at which the user is owed a handoff block (the prompts' `## Handoff` moments). */
export type HandoffMoment = "list-created" | "phase-closed" | "all-closed";

/**
 * Which handoff moment a successful mutation produced, if any: the list was just created, the
 * last open task of a phase closed, or the last open task of the whole list closed. The result
 * carries the cue right before the model writes its next text, where a system-prompt rule alone
 * proved unreliable on weaker models (senpi#2121 real-surface QA).
 */
export function handoffMomentOf(
	before: readonly TodoPhase[],
	after: readonly TodoPhase[],
	createsList: boolean,
): HandoffMoment | undefined {
	const hasOpen = (tasks: readonly TodoItem[]) => tasks.some((task) => !isTerminalTodoStatus(task.status));
	const afterTasks = after.flatMap((phase) => phase.tasks);
	if (afterTasks.length === 0) return undefined;
	if (createsList) return "list-created";
	if (!hasOpen(afterTasks)) return hasOpen(before.flatMap((phase) => phase.tasks)) ? "all-closed" : undefined;
	const closedPhase = after.some(
		(phase) =>
			phase.tasks.length > 0 &&
			!hasOpen(phase.tasks) &&
			hasOpen(before.find((prior) => prior.name === phase.name)?.tasks ?? []),
	);
	return closedPhase ? "phase-closed" : undefined;
}

export const HANDOFF_CUES: Readonly<Record<HandoffMoment, string>> = {
	"list-created":
		"Handoff due: the plan exists. Before your next tool call, write the Ask / For you / Now / Next block.",
	"phase-closed":
		"Handoff due: a phase closed. Before your next tool call, write the Ask / For you / Now / Next block.",
	"all-closed":
		"Handoff due: every task is closed. Your final message is the Ask / For you / Now / Next block, with Now and Next saying no task remains; any other report an instruction asks for (a self-review, a checklist, a summary) goes inside For you.",
};

/** The cue line appended to a todo result, or nothing when no handoff moment was reached. */
export function formatHandoffCue(moment: HandoffMoment | undefined): string {
	return moment ? `\n\n${HANDOFF_CUES[moment]}` : "";
}

/** `Ask:` / `Now:` / `Next:` lines plus a blank separator line. */
export function formatAskNowNextHeader(phases: readonly TodoPhase[], ask: TodoAsk | undefined): string {
	const anchors = describeAskNowNext({ phases, ask });
	return `Ask: ${anchors.ask}\nNow: ${anchors.now}\nNext: ${anchors.next}\n\n`;
}

export function formatSummary(
	phases: readonly TodoPhase[],
	errors: readonly string[],
	readOnly = false,
	ask?: TodoAsk,
): string {
	return `${formatAskNowNextHeader(phases, ask)}${formatListSummary(phases, errors, readOnly)}`;
}

function formatListSummary(phases: readonly TodoPhase[], errors: readonly string[], readOnly: boolean): string {
	const tasks = phases.flatMap((phase) => phase.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const remainingByPhase = phases
		.map((phase) => ({
			name: phase.name,
			tasks: phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter((phase) => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap((phase) =>
		phase.tasks.map((task) => ({ ...task, phase: phase.name })),
	);

	let currentIdx = phases.findIndex((phase) =>
		phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
	}

	const closedAll = tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
	const workedAhead = phases.some(
		(phase, index) =>
			index > currentIdx && phase.tasks.some((task) => task.status === "completed" || task.status === "abandoned"),
	);
	lines.push(`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open.`);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
			workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const tag = task.status === "in_progress" ? " (in progress)" : task.status === "abandoned" ? " (dropped)" : "";
			lines.push(`    - ${checkbox} ${task.content}${tag}`);
		}
	}
	return lines.join("\n");
}

export function sanitizeTodoText(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function isTerminalTodoStatus(status: string): boolean {
	return status === "completed" || status === "abandoned" || status === "cancelled";
}

export function isIncompleteTodo(todo: TodoItem): boolean {
	return !isTerminalTodoStatus(todo.status);
}

export function getTodoMarker(status: string): string {
	if (status === "completed") return "[✓]";
	if (status === "in_progress") return "[•]";
	if (status === "abandoned" || status === "cancelled") return "[×]";
	return "[ ]";
}

export function getTodoResultLines(phases: readonly TodoPhase[]): string[] {
	const tasks = phases.flatMap((phase) => phase.tasks);
	return [
		`${tasks.filter(isIncompleteTodo).length} todos`,
		...phases.flatMap((phase) => [
			`${sanitizeTodoText(phase.name)}:`,
			...phase.tasks.map((todo) => `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`),
		]),
	];
}
