import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { getAgentDir } from "../../../../config.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../types.ts";
import { parseGoalCommand } from "./command.ts";
import { shouldQueueGoalContinuationAfterAgentEnd, shouldQueueGoalContinuationWhenIdle } from "./continuation.ts";
import { formatGoalForTool, formatGoalToolResponse, goalStatusLabel } from "./format.ts";
import { buildContinuationPrompt } from "./prompt.ts";
import { accountGoalUsage, clearGoal, createGoal, readGoal, updateGoal } from "./store.ts";
import type { Goal, GoalAccountingMode, GoalStoreRef, TokenUsageSnapshot } from "./types.ts";
import { COMPLETABLE_GOAL_STATUS_VALUES, isRecord } from "./types.ts";
import { updateGoalUi } from "./ui.ts";

const GOAL_USAGE = "Usage: /goal <objective>";
const GOAL_EMPTY_HINT = "No goal is currently set.";
const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";
const REPLACE_GOAL_CHOICE = "Replace current goal";
const CANCEL_REPLACE_GOAL_CHOICE = "Cancel";
const RESUME_GOAL_CHOICE = "Resume goal";
const LEAVE_GOAL_PAUSED_CHOICE = "Leave paused";
const EMPTY_USAGE: TokenUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

type GoalToolResult = AgentToolResult<Record<string, never>>;
type AssistantUsageMessage = {
	role: "assistant";
	usage: Record<string, unknown>;
};
type AgentGoalAccounting = {
	goalId: string;
	measuredFromMilliseconds: number;
};

export default function goalExtension(pi: ExtensionAPI): void {
	let agentTurnInProgress = false;
	let agentGoalAccounting: AgentGoalAccounting | null = null;
	let completedThisTurnGoalId: string | null = null;

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nFails if a goal already exists; use update_goal only for status.",
		parameters: Type.Object(
			{
				objective: Type.String({
					description:
						"Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.",
				}),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ref = goalStoreRef(ctx);
			if ((await readGoal(ref)) !== null) {
				throw new Error(
					"cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete",
				);
			}
			const goal = await createGoal(ref, params.objective);
			beginAgentGoalAccounting(goal);
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal));
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Update the existing goal.\nUse this tool only to mark the goal achieved.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nDo not mark a goal complete merely because you are stopping work.\nYou cannot use this tool to pause or resume a goal; those status changes are controlled by the user or system.\nWhen marking the goal achieved with status `complete`, report the final elapsed time and token usage from the tool result to the user.",
		parameters: Type.Object(
			{
				status: Type.Union(
					COMPLETABLE_GOAL_STATUS_VALUES.map((status) => Type.Literal(status)),
					{
						description:
							"Required. Set to complete only when the objective is achieved and no required work remains.",
					},
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status !== "complete") {
				throw new Error(
					"update_goal can only mark the existing goal complete; pause and resume are controlled by the user or system",
				);
			}
			await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
			const goal = await updateGoal(goalStoreRef(ctx), { status: "complete" });
			markGoalCompletedThisTurn(goal);
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal));
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current goal for this thread, including status, token and elapsed-time usage.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const goal = await readGoal(goalStoreRef(ctx));
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal));
		},
	});

	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, or clear the persistent goal",
		handler: async (rawArgs, ctx) => {
			const command = parseGoalCommand(rawArgs);
			try {
				switch (command.kind) {
					case "show": {
						const goal = await readGoal(goalStoreRef(ctx));
						updateGoalUi(ctx, goal);
						ctx.ui.notify(
							goal === null ? `${GOAL_USAGE}\n${GOAL_EMPTY_HINT}` : formatGoalForTool(goal),
							goal ? "info" : "warning",
						);
						return;
					}
					case "setObjective": {
						await setGoalObjective(pi, ctx, command.objective);
						return;
					}
					case "setStatus": {
						if (command.status === "paused") {
							await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
						}
						const goal = await updateGoal(goalStoreRef(ctx), { status: command.status });
						if (goal.status === "active") {
							beginAgentGoalAccounting(goal);
						} else {
							stopAgentGoalAccounting(goal.id);
						}
						updateGoalUi(ctx, goal);
						ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
						queueGoalContinuation(pi, ctx, goal);
						return;
					}
					case "clear": {
						await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
						const cleared = await clearGoal(goalStoreRef(ctx));
						clearAgentGoalAccounting();
						updateGoalUi(ctx, null);
						ctx.ui.notify(
							cleared ? "Goal cleared" : "No goal to clear\nThis thread does not currently have a goal.",
							cleared ? "info" : "warning",
						);
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		updateGoalUi(ctx, goal);
		if (await maybePromptResumePausedGoal(pi, ctx, event.reason, goal)) {
			return;
		}
		if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
			queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentTurnInProgress = true;
		completedThisTurnGoalId = null;
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			agentGoalAccounting = null;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const mode: GoalAccountingMode = completedThisTurnGoalId === null ? "active" : "activeOrComplete";
		const goal = await accountCurrentAgentTurn(ctx, collectAssistantUsage(event.messages), mode);
		agentTurnInProgress = false;
		completedThisTurnGoalId = null;
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		updateGoalUiBestEffort(ctx, goal);
		if (goal?.status === "active" && shouldQueueGoalContinuationAfterAgentEnd(goal, ctx.hasPendingMessages())) {
			queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (agentGoalAccounting !== null) {
			await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
		}
		clearAgentGoalAccounting();
	});

	async function setGoalObjective(pi: ExtensionAPI, ctx: ExtensionContext, objective: string): Promise<void> {
		const ref = goalStoreRef(ctx);
		const current = await readGoal(ref);
		if (current !== null) {
			const shouldReplace = await confirmReplaceGoal(ctx, objective);
			if (!shouldReplace) return;
		}

		if (current?.status === "active") {
			await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
		}
		const goal = current === null ? await createGoal(ref, objective) : await updateGoal(ref, { objective });
		if (goal.status === "active") beginAgentGoalAccounting(goal);
		updateGoalUi(ctx, goal);
		ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
		queueGoalContinuation(pi, ctx, goal);
	}

	async function confirmReplaceGoal(ctx: ExtensionContext, objective: string): Promise<boolean> {
		if (!ctx.hasUI) return true;
		const choice = await ctx.ui.select(`Replace goal?\nNew objective: ${objective}`, [
			REPLACE_GOAL_CHOICE,
			CANCEL_REPLACE_GOAL_CHOICE,
		]);
		return choice === REPLACE_GOAL_CHOICE;
	}

	async function maybePromptResumePausedGoal(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		sessionStartReason: string,
		goal: Goal | null,
	): Promise<boolean> {
		if (!isResumeOfPausedGoal(ctx, sessionStartReason, goal)) {
			return false;
		}

		const choice = await ctx.ui.select(`Resume paused goal?\nGoal: ${goal.objective}`, [
			RESUME_GOAL_CHOICE,
			LEAVE_GOAL_PAUSED_CHOICE,
		]);
		if (choice !== RESUME_GOAL_CHOICE) return true;

		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" });
		beginAgentGoalAccounting(resumed);
		updateGoalUi(ctx, resumed);
		ctx.ui.notify(`Goal ${goalStatusLabel(resumed.status)}\n${formatGoalForTool(resumed)}`, "info");
		queueGoalContinuation(pi, ctx, resumed);
		return true;
	}

	function beginAgentGoalAccounting(goal: Goal): void {
		if (goal.status !== "active") return;
		if (agentGoalAccounting?.goalId === goal.id) return;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function markGoalCompletedThisTurn(goal: Goal): void {
		if (!agentTurnInProgress) return;
		completedThisTurnGoalId = goal.id;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function stopAgentGoalAccounting(goalId: string): void {
		if (agentGoalAccounting?.goalId === goalId) {
			agentGoalAccounting = null;
		}
		if (completedThisTurnGoalId === goalId) {
			completedThisTurnGoalId = null;
		}
	}

	function clearAgentGoalAccounting(): void {
		agentGoalAccounting = null;
		completedThisTurnGoalId = null;
	}

	async function accountCurrentAgentTurn(
		ctx: ExtensionContext,
		usage: TokenUsageSnapshot,
		mode: GoalAccountingMode,
	): Promise<Goal | null> {
		const accounting = agentGoalAccounting;
		const ref = goalStoreRef(ctx);
		if (accounting === null) return readGoal(ref);

		const now = Date.now();
		const elapsedSeconds = Math.max(0, Math.round((now - accounting.measuredFromMilliseconds) / 1000));
		const goal = await accountGoalUsage(ref, usage, elapsedSeconds, mode, accounting.goalId);
		if (goal?.id === accounting.goalId) {
			agentGoalAccounting = { goalId: accounting.goalId, measuredFromMilliseconds: now };
		} else {
			clearAgentGoalAccounting();
		}
		return goal;
	}
}

function updateGoalUiBestEffort(ctx: ExtensionContext, goal: Goal | null): void {
	try {
		updateGoalUi(ctx, goal);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)) {
			return;
		}
		throw error;
	}
}

function isResumeOfPausedGoal(ctx: ExtensionContext, sessionStartReason: string, goal: Goal | null): goal is Goal {
	return (
		sessionStartReason === "resume" &&
		goal?.status === "paused" &&
		ctx.hasUI &&
		ctx.isIdle() &&
		!ctx.hasPendingMessages()
	);
}

function queueGoalContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: Goal): void {
	if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
		queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
	}
}

function queueHiddenGoalPrompt(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{ customType: GOAL_CONTINUATION_MESSAGE_TYPE, content, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

function goalStoreRef(ctx: ExtensionContext): GoalStoreRef {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const baseDir =
		sessionFile === undefined
			? join(getAgentDir(), "extensions", "goal", "no-session", cwdStoreKey(ctx.cwd))
			: join(ctx.sessionManager.getSessionDir(), "extensions", "goal");

	return {
		baseDir,
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function cwdStoreKey(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}

function toolText(text: string): GoalToolResult {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function collectAssistantUsage(messages: unknown[]): TokenUsageSnapshot {
	const usage: TokenUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	for (const message of messages) {
		if (!isAssistantUsageMessage(message)) continue;
		usage.input += numericUsageField(message.usage, "input");
		usage.output += numericUsageField(message.usage, "output");
		usage.cacheRead += numericUsageField(message.usage, "cacheRead");
		usage.cacheWrite += numericUsageField(message.usage, "cacheWrite");
		usage.totalTokens += numericUsageField(message.usage, "totalTokens");
	}
	return usage;
}

function isAssistantUsageMessage(message: unknown): message is AssistantUsageMessage {
	if (!isRecord(message)) return false;
	return message.role === "assistant" && isRecord(message.usage);
}

function numericUsageField(usage: Record<string, unknown>, key: string): number {
	const value = usage[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
