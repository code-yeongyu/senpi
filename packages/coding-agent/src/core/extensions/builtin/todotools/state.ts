// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripAnsi } from "../../../../utils/ansi.ts";
import type { SessionEntry } from "../../../session-manager.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";

export type TodoItem = {
	content: string;
	status: TodoStatus;
};

export type TodoPhase = {
	name: string;
	tasks: TodoItem[];
};

export type TodoCompletionTransition = {
	phase: string;
	content: string;
};

export type TodoToolDetails = {
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
};

export type TodoStateEntry = {
	schema: "v2";
	phases: TodoPhase[];
};

export const TODO_STATE_ENTRY_TYPE = "senpi.todo-state";
export const DEFAULT_INIT_PHASE = "Tasks";

type TodoPhaseInput = {
	phase: string;
	items: string[];
};

export type TodoOpEntry = {
	op: TodoOperation;
	list?: TodoPhaseInput[];
	task?: string;
	phase?: string;
	items?: string[];
};

type TaskHit = {
	task: TodoItem;
	phase: TodoPhase;
};

type BranchEntry = SessionEntry;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function parseTodoStatus(value: unknown): TodoStatus | undefined {
	if (value === "cancelled") return "abandoned";
	return isTodoStatus(value) ? value : undefined;
}

function parseTodoItem(value: unknown, options?: { lenient?: boolean }): TodoItem | undefined {
	if (!isRecord(value) || typeof value.content !== "string") return undefined;
	const status = parseTodoStatus(value.status) ?? (options?.lenient ? "pending" : undefined);
	return status ? { content: value.content, status } : undefined;
}

function parseTodoPhase(value: unknown): TodoPhase | undefined {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return undefined;
	const tasks: TodoItem[] = [];
	for (const task of value.tasks) {
		const parsed = parseTodoItem(task);
		if (!parsed) return undefined;
		tasks.push(parsed);
	}
	return { name: value.name, tasks };
}

function parsePhases(value: unknown): TodoPhase[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const phases: TodoPhase[] = [];
	for (const phase of value) {
		const parsed = parseTodoPhase(phase);
		if (!parsed) return undefined;
		phases.push(parsed);
	}
	return phases;
}

function parseLegacyTodos(value: unknown): TodoPhase[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tasks: TodoItem[] = [];
	for (const todo of value) {
		// Legacy todowrite persisted arbitrary status strings (e.g. "blocked").
		// Preserve those entries instead of dropping the whole list: unknown
		// statuses become "pending" so the task survives migration as open work.
		const parsed = parseTodoItem(todo, { lenient: true });
		if (!parsed) return undefined;
		tasks.push(parsed);
	}
	return [{ name: DEFAULT_INIT_PHASE, tasks }];
}

function readTodoPayload(value: unknown): TodoPhase[] | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schema === "v2") return parsePhases(value.phases);
	if (Array.isArray(value.phases)) return parsePhases(value.phases);
	if (Array.isArray(value.todos)) return parseLegacyTodos(value.todos);
	return undefined;
}

export function findTaskByContent(phases: TodoPhase[], content: string): TaskHit | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find((candidate) => candidate.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

export function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find((phase) => phase.name === name);
}

export function cloneTask(task: TodoItem): TodoItem {
	return { content: task.content, status: task.status };
}

export function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

export function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap((phase) => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter((task) => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) task.status = "pending";
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find((task) => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/** Return the active task, preferring an in-progress item over the first pending item. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

export function getCompletionTransitions(
	previous: readonly TodoPhase[],
	updated: readonly TodoPhase[],
): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) previousStatuses.set(`${phase.name}\u0000${task.content}`, task.status);
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(`${phase.name}\u0000${task.content}`);
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return transitions;
}

export function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): TaskHit | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

export function resolvePhaseOrError(
	phases: TodoPhase[],
	name: string | undefined,
	errors: string[],
): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

export function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap((phase) => phase.tasks);
}

export function initPhases(entry: TodoOpEntry, errors: string[]): TodoPhase[] {
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}

	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		if (seenPhases.has(listEntry.phase)) errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		seenPhases.add(listEntry.phase);
		if (listEntry.items.length === 0) errors.push(`Phase "${listEntry.phase}" has no tasks in init list`);
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) errors.push(`Duplicate task "${content}" in init list`);
			seenTasks.add(content);
		}
	}

	return list.map((listEntry) => ({
		name: listEntry.phase,
		tasks: listEntry.items.map((content) => ({ content, status: "pending" })),
	}));
}

export function appendItems(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) phase.tasks.push({ content, status: "pending" });
	return phases;
}

export function removeTasks(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) phase.tasks = [];
	return phases;
}

export function applyEntry(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) candidate.status = "pending";
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done":
			for (const task of getTaskTargets(phases, entry, errors)) task.status = "completed";
			return phases;
		case "drop":
			for (const task of getTaskTargets(phases, entry, errors)) task.status = "abandoned";
			return phases;
		case "rm":
			return removeTasks(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
		case "view":
			return phases;
	}
}

export function applyParams(phases: TodoPhase[], params: TodoOpEntry): { phases: TodoPhase[]; errors: string[] } {
	if (params.op === "view") return { phases, errors: [] };
	const original = clonePhases(phases);
	const errors: string[] = [];
	const next = applyEntry(phases, params, errors);
	if (errors.length > 0) return { phases: original, errors };
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

export function applyOpsToPhases(
	currentPhases: readonly TodoPhase[],
	ops: readonly TodoOpEntry[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = clonePhases(currentPhases);
	for (const op of ops) next = applyEntry(next, op, errors);
	if (errors.length > 0) return { phases: clonePhases(currentPhases), errors };
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

export function formatSummary(phases: readonly TodoPhase[], errors: readonly string[], readOnly = false): string {
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

function getActivePhase(phases: readonly TodoPhase[]): TodoPhase | undefined {
	const activeTask = nextActionableTask(phases);
	if (!activeTask) return undefined;
	return phases.find((phase) => phase.tasks.includes(activeTask));
}

export function getTodoWidgetLines(phases: readonly TodoPhase[]): string[] | undefined {
	const activePhase = getActivePhase(phases);
	if (!activePhase) return undefined;
	return [
		"Todo",
		sanitizeTodoText(activePhase.name),
		...activePhase.tasks.map((todo) => `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`),
	];
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

export function isTodoItem(value: unknown): value is TodoItem {
	return parseTodoItem(value) !== undefined;
}

export function isTodoItemArray(value: unknown): value is TodoItem[] {
	return Array.isArray(value) && value.every(isTodoItem);
}

export function isTodoPhase(value: unknown): value is TodoPhase {
	return parseTodoPhase(value) !== undefined;
}

export function isTodoPhaseArray(value: unknown): value is TodoPhase[] {
	return Array.isArray(value) && value.every(isTodoPhase);
}

function isTodoToolResult(message: AgentMessage): message is Extract<AgentMessage, { role: "toolResult" }> {
	return message.role === "toolResult" && (message.toolName === "todo" || message.toolName === "todowrite");
}

export function getLatestPhasesFromBranchEntries(entries: BranchEntry[]): TodoPhase[] {
	let phases: TodoPhase[] = [];

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE) {
			const parsed = readTodoPayload(entry.data);
			if (parsed) phases = clonePhases(parsed);
			continue;
		}

		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message as AgentMessage;
		if (!isTodoToolResult(message)) continue;

		const parsed = readTodoPayload(message.details);
		if (parsed) phases = clonePhases(parsed);
	}

	return phases;
}

/** Compatibility reader for callers that still expect the old flat array. */
export function getLatestTodosFromBranchEntries(entries: BranchEntry[]): TodoItem[] {
	return getLatestPhasesFromBranchEntries(entries).flatMap((phase) => phase.tasks.map(cloneTask));
}
