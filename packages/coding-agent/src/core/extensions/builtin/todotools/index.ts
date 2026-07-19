import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { TASK_MANAGEMENT_SECTION } from "./prompt.ts";
import { clonePhases, getLatestPhasesFromBranchEntries, getTodoWidgetLines, type TodoPhase } from "./state.ts";
import { registerTodoTool } from "./tools/todo.ts";

function getLatestPhases(ctx: ExtensionContext): TodoPhase[] {
	return getLatestPhasesFromBranchEntries(ctx.sessionManager.getBranch());
}

export default function todotoolsExtension(pi: ExtensionAPI): void {
	let currentPhases: TodoPhase[] = [];

	const getCurrentPhases = (): TodoPhase[] => clonePhases(currentPhases);

	const setCurrentPhases = (phases: TodoPhase[]): void => {
		currentPhases = clonePhases(phases);
	};

	const syncWidget = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget("todo-sidebar", getTodoWidgetLines(currentPhases));
	};

	const syncFromSession = (ctx: ExtensionContext): void => {
		currentPhases = getLatestPhases(ctx);
		syncWidget(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n${TASK_MANAGEMENT_SECTION}`,
		};
	});

	registerTodoTool(pi, { getCurrentPhases, setCurrentPhases, syncWidget });
}

export { TASK_MANAGEMENT_SECTION } from "./prompt.ts";
export {
	appendItems,
	applyEntry,
	applyOpsToPhases,
	applyParams,
	clonePhases,
	cloneTask,
	DEFAULT_INIT_PHASE,
	findPhaseByName,
	findTaskByContent,
	formatSummary,
	getCompletionTransitions,
	getLatestPhasesFromBranchEntries,
	getLatestTodosFromBranchEntries,
	getTaskTargets,
	getTodoMarker,
	getTodoResultLines,
	getTodoWidgetLines,
	initPhases,
	isIncompleteTodo,
	isTerminalTodoStatus,
	isTodoItem,
	isTodoItemArray,
	isTodoPhase,
	isTodoPhaseArray,
	nextActionableTask,
	normalizeInProgressTask,
	removeTasks,
	resolvePhaseOrError,
	resolveTaskOrError,
	sanitizeTodoText,
	TODO_STATE_ENTRY_TYPE,
	type TodoCompletionTransition,
	type TodoItem,
	type TodoOpEntry,
	type TodoOperation,
	type TodoPhase,
	type TodoStateEntry,
	type TodoStatus,
	type TodoToolDetails,
} from "./state.ts";
export { phaseRomanNumeral } from "./tools/todo.ts";
