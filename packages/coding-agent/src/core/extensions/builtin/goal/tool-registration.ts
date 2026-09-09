import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../types.ts";
import { formatGoalToolResponse, type GoalToolRenderDetails, goalToolRenderDetails } from "./format.ts";
import { renderGoalToolCall, renderGoalToolResult } from "./renderers.ts";
import { createGoal, objectiveFullTextFileName, readGoal, updateGoal } from "./store.ts";
import { openTodoCompletionError, openTodoTaskContents } from "./todo-gate.ts";
import type { Goal, GoalAccountingMode, GoalStoreRef } from "./types.ts";
import { MODEL_SETTABLE_GOAL_STATUS_VALUES } from "./types.ts";
import { objectiveTruncationNotice, validateObjective } from "./validation.ts";

type GoalToolResult = AgentToolResult<GoalToolRenderDetails>;

export type GoalToolRegistrationDeps = {
	readonly goalStoreRef: (ctx: ExtensionContext) => GoalStoreRef;
	readonly accountCurrentAgentTurn: (ctx: ExtensionContext, mode: GoalAccountingMode) => Promise<Goal | null>;
	readonly beginAgentGoalAccounting: (goal: Goal) => void;
	readonly markGoalBlockedThisTurn: (goal: Goal) => void;
	readonly markGoalCompletedThisTurn: (goal: Goal) => void;
	readonly refreshGoalUi: (ctx: ExtensionContext, goal: Goal | null) => void;
};

export function registerGoalTools(pi: ExtensionAPI, deps: GoalToolRegistrationDeps): void {
	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nObjectives are limited to 4,000 characters. For longer instructions, put the full objective in a file and refer to that file.\nReplaces the current goal when it is complete and archives it; fails if an unfinished goal exists.",
		parameters: Type.Object(
			{
				objective: Type.String({
					description:
						"Required. The concrete objective to start pursuing. Limit: 4,000 characters. For longer instructions, put the full objective in a file and refer to that file.",
				}),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ref = deps.goalStoreRef(ctx);
			const current = await readGoal(ref);
			if (current !== null && current.status !== "complete") {
				throw new Error(
					"cannot create a new goal because this thread already has an unfinished goal; use update_goal only when the existing goal is complete",
				);
			}
			const validatedObjective = validateObjective(params.objective, objectiveFullTextFileName(ref));
			const goal = await createGoal(ref, params.objective);
			deps.beginAgentGoalAccounting(goal);
			deps.refreshGoalUi(ctx, goal);
			const notice = validatedObjective.truncated
				? objectiveTruncationNotice(objectiveFullTextFileName(ref))
				: undefined;
			return toolText(formatGoalToolResponse(goal, notice), goalToolRenderDetails(goal, notice));
		},
		renderCall: (args, theme) => renderGoalToolCall("create_goal", args, theme),
		renderResult: (result, options, theme) => renderGoalToolResult(result, options, theme),
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Set the existing goal's status to `complete` or `blocked`; the completion audit and blocked audit in the goal continuation prompt decide which, and only a passing audit permits the call.\n`complete` is rejected while todo tasks are open, and stopping work is never by itself a reason to complete; after it succeeds, report the final elapsed time and token usage from the result to the user.\n`blocked` requires a non-empty `reason` (omit `reason` for `complete`); a user resume starts a fresh blocked audit.\nPausing and resuming are user or system actions, not this tool.",
		parameters: Type.Object(
			{
				status: Type.Union(
					MODEL_SETTABLE_GOAL_STATUS_VALUES.map((status) => Type.Literal(status)),
					{ description: "Required. Set to complete when achieved or blocked with a non-empty reason." },
				),
				reason: Type.Optional(
					Type.String({
						description: "Required and non-empty when status is blocked; rejected when status is complete.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;
			if (params.status === "blocked" && (reason === undefined || reason.length === 0)) {
				throw new Error("reason is required when status is blocked");
			}
			if (params.status === "complete" && reason !== undefined && reason.length > 0) {
				throw new Error("reason must not be provided when status is complete");
			}
			if (params.status === "complete") {
				const openTasks = openTodoTaskContents(ctx.sessionManager.getBranch());
				if (openTasks.length > 0) throw new Error(openTodoCompletionError(openTasks));
			}
			await deps.accountCurrentAgentTurn(ctx, "active");
			const goal = await updateGoal(
				deps.goalStoreRef(ctx),
				params.status === "blocked" ? { status: "blocked", reason } : { status: "complete" },
				"model",
			);
			if (goal.status === "blocked") deps.markGoalBlockedThisTurn(goal);
			else deps.markGoalCompletedThisTurn(goal);
			deps.refreshGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal), goalToolRenderDetails(goal));
		},
		renderCall: (args, theme) => renderGoalToolCall("update_goal", args, theme),
		renderResult: (result, options, theme) => renderGoalToolResult(result, options, theme),
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current goal for this thread, including status, token and elapsed-time usage.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const goal = await deps.accountCurrentAgentTurn(ctx, "active");
			deps.refreshGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal), goalToolRenderDetails(goal));
		},
		renderCall: (args, theme) => renderGoalToolCall("get_goal", args, theme),
		renderResult: (result, options, theme) => renderGoalToolResult(result, options, theme),
	});
}

function toolText(text: string, details: GoalToolRenderDetails): GoalToolResult {
	return { content: [{ type: "text" as const, text }], details };
}
