// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

export {
	formatSummary,
	getTodoMarker,
	getTodoResultLines,
	isIncompleteTodo,
	isTerminalTodoStatus,
	sanitizeTodoText,
} from "./todo-format.ts";
export {
	appendItems,
	applyEntry,
	applyOpsToPhases,
	applyParams,
	initPhases,
	removeTasks,
} from "./todo-operations.ts";
export {
	findPhaseByName,
	findTaskByContent,
	getCompletionTransitions,
	nextActionableTask,
	normalizeInProgressTask,
} from "./todo-query.ts";
export { getTaskTargets, resolvePhaseOrError, resolveTaskOrError } from "./todo-resolution.ts";
export {
	clonePhases,
	cloneTask,
	getLatestPhasesFromBranchEntries,
	getLatestTodosFromBranchEntries,
	isTodoItem,
	isTodoItemArray,
	isTodoPhase,
	isTodoPhaseArray,
} from "./todo-storage.ts";
export {
	DEFAULT_INIT_PHASE,
	TODO_STATE_ENTRY_TYPE,
	type TodoCompletionTransition,
	type TodoItem,
	type TodoOpEntry,
	type TodoOperation,
	type TodoPhase,
	type TodoStateEntry,
	type TodoStatus,
	type TodoToolDetails,
} from "./todo-types.ts";
export {
	getTodoWidgetLines,
	getTodoWidgetModel,
	type TodoWidgetModel,
	type TodoWidgetRow,
} from "./todo-widget.ts";
