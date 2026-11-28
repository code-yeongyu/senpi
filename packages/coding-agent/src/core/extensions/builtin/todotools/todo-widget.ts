// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { getTodoMarker, isIncompleteTodo, sanitizeTodoText } from "./todo-format.ts";
import { nextActionableTask } from "./todo-query.ts";
import type { TodoItem, TodoPhase } from "./todo-types.ts";

const TODO_WIDGET_MAX_LINES = 10;
const TODO_WIDGET_HEADER_LINES = 2;
const TODO_WIDGET_RECENT_TASKS = 2;

export type TodoWidgetRow =
	| {
			readonly kind: "label";
			readonly text: string;
	  }
	| {
			readonly kind: "task";
			readonly task: TodoItem;
	  };

export type TodoWidgetModel = {
	readonly phaseName: string;
	readonly rows: readonly TodoWidgetRow[];
};

/** Whether the session is working or has live background work; only then is an item drawn as active. */
type TodoWidgetLiveness = { readonly working: boolean };

function getActivePhase(phases: readonly TodoPhase[]): TodoPhase | undefined {
	const activeTask = nextActionableTask(phases);
	if (!activeTask) return undefined;
	return phases.find((phase) => phase.tasks.includes(activeTask));
}

function formatOmittedTasks(count: number, direction: "earlier" | "later"): string {
	return `... (${count} ${direction} task${count === 1 ? "" : "s"})`;
}

function formatTask(todo: TodoItem): string {
	return `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`;
}

function label(text: string): TodoWidgetRow {
	return { kind: "label", text };
}

function taskRow(task: TodoItem): TodoWidgetRow {
	return { kind: "task", task };
}

function pausedRow(row: TodoWidgetRow): TodoWidgetRow {
	return row.kind === "task" && row.task.status === "in_progress" ? taskRow({ ...row.task, status: "pending" }) : row;
}

export function getTodoWidgetModel(
	phases: readonly TodoPhase[],
	liveness: TodoWidgetLiveness,
): TodoWidgetModel | undefined {
	const window = getActivePhaseWindow(phases);
	if (!window) return undefined;
	if (liveness.working) return window;
	// Not working: no row carries the active mark and the title says so (senpi#1146).
	const openCount = phases.reduce((count, phase) => count + phase.tasks.filter(isIncompleteTodo).length, 0);
	const [, ...body] = window.rows;
	return {
		phaseName: window.phaseName,
		rows: [label(`Todo · paused · ${openCount} open`), ...body.map(pausedRow)],
	};
}

function getActivePhaseWindow(phases: readonly TodoPhase[]): TodoWidgetModel | undefined {
	const activePhase = getActivePhase(phases);
	if (!activePhase) return undefined;
	const header = [label("Todo"), label(sanitizeTodoText(activePhase.name))];
	const taskRows = activePhase.tasks.map(taskRow);
	if (header.length + taskRows.length <= TODO_WIDGET_MAX_LINES) {
		return {
			phaseName: activePhase.name,
			rows: [...header, ...taskRows],
		};
	}

	const activeTask = nextActionableTask([activePhase]);
	if (!activeTask) return undefined;
	const activeIndex = activePhase.tasks.indexOf(activeTask);
	const firstVisibleTask = Math.max(0, activeIndex - TODO_WIDGET_RECENT_TASKS);
	const earlierOmitted = firstVisibleTask;
	const bodyBudget = TODO_WIDGET_MAX_LINES - TODO_WIDGET_HEADER_LINES;
	const recentAndActive = activePhase.tasks.slice(firstVisibleTask, activeIndex + 1).map(taskRow);
	const earlierMarkerRows = earlierOmitted > 0 ? 1 : 0;
	const pendingAfterActive = activePhase.tasks.slice(activeIndex + 1).filter((todo) => todo.status === "pending");
	const upcomingBudget = bodyBudget - recentAndActive.length - earlierMarkerRows;
	const visibleUpcomingCount =
		pendingAfterActive.length > upcomingBudget ? Math.max(0, upcomingBudget - 1) : pendingAfterActive.length;
	const laterOmitted = pendingAfterActive.length - visibleUpcomingCount;

	return {
		phaseName: activePhase.name,
		rows: [
			...header,
			...(earlierOmitted > 0 ? [label(formatOmittedTasks(earlierOmitted, "earlier"))] : []),
			...recentAndActive,
			...pendingAfterActive.slice(0, visibleUpcomingCount).map(taskRow),
			...(laterOmitted > 0 ? [label(formatOmittedTasks(laterOmitted, "later"))] : []),
		],
	};
}

export function getTodoWidgetLines(
	phases: readonly TodoPhase[],
	liveness: TodoWidgetLiveness = { working: true },
): string[] | undefined {
	const model = getTodoWidgetModel(phases, liveness);
	if (!model) return undefined;
	return model.rows.map((row) => (row.kind === "label" ? row.text : formatTask(row.task)));
}
