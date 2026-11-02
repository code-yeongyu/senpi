import { createSessionLogger, type SessionLogger } from "../../../session-log.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { registerTodoCommand } from "./commands.ts";
import { FIRST_TURN_CUSTOM_TYPE, FIRST_TURN_REMINDER, shouldArmFirstTurn, withForcedTodoChoice } from "./first-turn.ts";
import { phasesFromCursorTodos } from "./native-todo-mirror.ts";
import { TASK_MANAGEMENT_SECTION } from "./prompt.ts";
import {
	clonePhases,
	getLatestTodoStateFromBranchEntries,
	type TodoAsk,
	type TodoCompletionTransition,
	type TodoPhase,
	type TodoState,
} from "./state.ts";
import { TODO_STATE_ENTRY_TYPE } from "./todo-types.ts";
import { getTodoWidgetModel } from "./todo-widget.ts";
import { TodoWidgetComponent } from "./todo-widget-component.ts";
import { registerTodoTool } from "./tools/todo.ts";

function readFirstTurnPlan(ctx: ExtensionContext) {
	return SettingsManager.create(ctx.cwd, ctx.agentDir, {
		projectTrusted: ctx.isProjectTrusted(),
	}).getTodoFirstTurnPlan();
}

export default function todotoolsExtension(pi: ExtensionAPI): void {
	let currentState: TodoState = { phases: [], ask: undefined };
	// Armed by the first-turn opener; cleared once that run's first assistant message lands.
	let pendingForce: { forceNamed: boolean; logged: boolean } | undefined;
	let logger: SessionLogger | undefined;
	const clearPendingForce = (): void => {
		pendingForce = undefined;
	};

	const getCurrentPhases = (): TodoPhase[] => clonePhases(currentState.phases);

	const setCurrentPhases = (phases: TodoPhase[]): void => {
		currentState = { ...currentState, phases: clonePhases(phases) };
	};

	const getCurrentAsk = (): TodoAsk | undefined => currentState.ask;

	const setCurrentAsk = (ask: TodoAsk | undefined): void => {
		currentState = { ...currentState, ask };
	};

	const syncWidget = (ctx: ExtensionContext, completedTasks: readonly TodoCompletionTransition[] = []): void => {
		const model = getTodoWidgetModel(currentState.phases);
		ctx.ui.setWidget(
			"todo-sidebar",
			model ? (tui, theme) => new TodoWidgetComponent(tui, theme, model, completedTasks) : undefined,
		);
	};

	const syncFromSession = (ctx: ExtensionContext): void => {
		currentState = getLatestTodoStateFromBranchEntries(ctx.sessionManager.getBranch());
		syncWidget(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		clearPendingForce();
		syncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		clearPendingForce();
		syncFromSession(ctx);
	});

	pi.on("agent_end", clearPendingForce);
	pi.on("session_abort", clearPendingForce);
	pi.on("session_shutdown", clearPendingForce);

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message?.role === "assistant") clearPendingForce();
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			return;
		}
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "todo" || block.arguments?.op) {
				continue;
			}
			const phases = phasesFromCursorTodos(block.arguments?.todos);
			if (phases === undefined) {
				continue;
			}
			setCurrentPhases(phases);
			const ask = getCurrentAsk();
			pi.appendEntry(TODO_STATE_ENTRY_TYPE, { schema: "v2", phases, ...(ask ? { ask } : {}) });
			syncWidget(ctx);
		}
	});

	pi.on(
		"before_agent_start",
		async (event, ctx) => {
			const systemPrompt = `${event.systemPrompt}\n${TASK_MANAGEMENT_SECTION}`;
			if (event.preview) return { systemPrompt };
			const branchEntries = ctx.sessionManager.getBranch();
			const setting = readFirstTurnPlan(ctx);
			const armed = shouldArmFirstTurn({
				preview: event.preview,
				trigger: event.trigger,
				prompt: event.prompt,
				branchEntries,
				todoActive: pi.getActiveTools().includes("todo"),
				setting,
				mode: ctx.mode,
			});
			if (!armed) return { systemPrompt };
			pendingForce = { forceNamed: setting === "force", logged: false };
			return {
				systemPrompt,
				message: { customType: FIRST_TURN_CUSTOM_TYPE, content: FIRST_TURN_REMINDER, display: false },
			};
		},
		{ previewSafe: true },
	);

	pi.on("before_provider_request", async (event, ctx) => {
		if (!pendingForce) return undefined;
		const forced = pendingForce.forceNamed
			? withForcedTodoChoice(event.payload, event.model ?? ctx.model)
			: undefined;
		if (!pendingForce.logged) {
			pendingForce.logged = true;
			logger ??= createSessionLogger(ctx.agentDir);
			logger.info("todo_first_turn", { mode: forced === undefined ? "reminder-only" : "forced" });
		}
		return forced;
	});

	const accessors = { getCurrentPhases, setCurrentPhases, getCurrentAsk, setCurrentAsk, syncWidget };
	registerTodoTool(pi, accessors);
	registerTodoCommand(pi, accessors);
}

export { findPhaseFuzzy, findTaskFuzzy, registerTodoCommand, tokenizeTodoArgs } from "./commands.ts";
export { markdownToPhases, phasesToMarkdown, resolveTodoMarkdownPath } from "./markdown.ts";
export { TASK_MANAGEMENT_SECTION } from "./prompt.ts";
export {
	appendItems,
	applyEntry,
	applyOpsToPhases,
	applyParams,
	clonePhases,
	cloneTask,
	DEFAULT_INIT_PHASE,
	describeAskNowNext,
	findPhaseByName,
	findTaskByContent,
	formatSummary,
	getCompletionTransitions,
	getLatestPhasesFromBranchEntries,
	getLatestTodoStateFromBranchEntries,
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
	type TodoAsk,
	type TodoCompletionTransition,
	type TodoItem,
	type TodoOpEntry,
	type TodoOperation,
	type TodoPhase,
	type TodoState,
	type TodoStateEntry,
	type TodoStatus,
	type TodoToolDetails,
} from "./state.ts";
export { phaseRomanNumeral } from "./tools/todo.ts";
