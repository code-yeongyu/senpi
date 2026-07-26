import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { registerGoalCommand } from "./command-registration.ts";
import { shouldQueueGoalContinuationAfterAgentEnd } from "./continuation.ts";
import { GoalElapsedTicker } from "./elapsed-ticker.ts";
import { formatGoalForTool, goalStatusLabel } from "./format.ts";
import { isResumeOfPausedGoal, queueGoalContinuation, queueHiddenGoalPrompt } from "./lifecycle-helpers.ts";
import { buildContinuationPrompt } from "./prompt.ts";
import { accountGoalUsage, readGoal, updateGoal } from "./store.ts";
import { goalStoreRef as buildGoalStoreRef } from "./store-ref.ts";
import { registerGoalTools } from "./tool-registration.ts";
import { TurnUsageTracker } from "./turn-usage.ts";
import type { Goal, GoalAccountingMode, GoalStoreRef } from "./types.ts";
import { updateGoalUi } from "./ui.ts";

const RESUME_GOAL_CHOICE = "Resume goal";
const LEAVE_GOAL_PAUSED_CHOICE = "Leave paused";
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

type AgentGoalAccounting = {
	goalId: string;
	measuredFromMilliseconds: number;
};

export default function goalExtension(pi: ExtensionAPI): void {
	let agentTurnInProgress = false;
	let agentGoalAccounting: AgentGoalAccounting | null = null;
	let blockedThisTurnGoalId: string | null = null;
	let completedThisTurnGoalId: string | null = null;
	const turnUsage = new TurnUsageTracker();

	const goalTicker = new GoalElapsedTicker({
		render: (renderCtx, renderGoal, live) => {
			try {
				updateGoalUi(renderCtx, renderGoal, live);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)) return;
				throw error;
			}
		},
	});

	registerGoalTools(pi, {
		goalStoreRef: (ctx) => buildGoalStoreRef(ctx.sessionManager, ctx.cwd),
		accountCurrentAgentTurn,
		beginAgentGoalAccounting,
		markGoalBlockedThisTurn,
		markGoalCompletedThisTurn,
		refreshGoalUi,
	});
	registerGoalCommand(pi, {
		goalStoreRef: (ctx) => buildGoalStoreRef(ctx.sessionManager, ctx.cwd),
		accountCurrentAgentTurn,
		beginAgentGoalAccounting,
		stopAgentGoalAccounting,
		clearAgentGoalAccounting,
		queueGoalContinuation,
		refreshGoalUi,
	});

	pi.on("session_start", async (event, ctx) => {
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		refreshGoalUi(ctx, goal);
		if (await maybePromptResumePausedGoal(pi, ctx, event.reason, goal)) {
			return;
		}
		if (goal) queueGoalContinuation(pi, ctx, goal);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// before_agent_start fires only for real user prompts and BEFORE the host's final
		// provider admission check (which can reject the run so no agent_start follows).
		// Resuming a blocked goal here, instead of deferring to agent_start via a sticky
		// flag, means a rejected run cannot leak a stale resume signal to a later
		// continuation-style turn that starts the agent without a preceding user prompt.
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "blocked") {
			const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
			refreshGoalUi(ctx, resumed);
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentTurnInProgress = true;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		turnUsage.reset();
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			agentGoalAccounting = null;
		}
	});

	pi.on("message_end", async (event) => {
		turnUsage.noteMessageEnd(event.message);
	});

	pi.on("agent_end", async (event, ctx) => {
		const mode: GoalAccountingMode =
			blockedThisTurnGoalId !== null
				? "activeOrBlocked"
				: completedThisTurnGoalId === null
					? "active"
					: "activeOrComplete";
		let goal = await accountCurrentAgentTurn(ctx, mode, event.messages);
		agentTurnInProgress = false;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		if (event.aborted === true && event.abortSource === "user" && goal?.status === "active") {
			goal = await updateGoal(
				goalStoreRef(ctx),
				{ status: "blocked", reason: "user interrupted the turn" },
				"model",
			);
		}
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		refreshGoalUiBestEffort(ctx, goal);
		if (
			goal?.status === "active" &&
			!event.aborted &&
			shouldQueueGoalContinuationAfterAgentEnd(goal, ctx.hasPendingMessages(), event.messages)
		) {
			queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (agentGoalAccounting !== null) {
			await accountCurrentAgentTurn(ctx, "active");
		}
		clearAgentGoalAccounting();
		goalTicker.stop();
	});

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

		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		beginAgentGoalAccounting(resumed);
		refreshGoalUi(ctx, resumed);
		ctx.ui.notify(`Goal ${goalStatusLabel(resumed.status)}\n${formatGoalForTool(resumed)}`, "info");
		queueGoalContinuation(pi, ctx, resumed);
		return true;
	}

	function beginAgentGoalAccounting(goal: Goal): void {
		if (goal.status !== "active") return;
		if (agentGoalAccounting?.goalId === goal.id) return;
		turnUsage.discardPending();
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function markGoalBlockedThisTurn(goal: Goal): void {
		if (agentTurnInProgress) blockedThisTurnGoalId = goal.id;
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
		if (blockedThisTurnGoalId === goalId) {
			blockedThisTurnGoalId = null;
		}
		if (completedThisTurnGoalId === goalId) {
			completedThisTurnGoalId = null;
		}
	}

	function clearAgentGoalAccounting(): void {
		agentGoalAccounting = null;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
	}

	function refreshGoalUi(ctx: ExtensionContext, goal: Goal | null): void {
		const accounting = agentGoalAccounting;
		if (ctx.hasUI && goal?.status === "active" && accounting?.goalId === goal.id) {
			goalTicker.sync(ctx, goal, accounting.measuredFromMilliseconds);
			return;
		}
		goalTicker.stop();
		updateGoalUi(ctx, goal);
	}

	function refreshGoalUiBestEffort(ctx: ExtensionContext, goal: Goal | null): void {
		try {
			refreshGoalUi(ctx, goal);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)) {
				return;
			}
			throw error;
		}
	}

	async function accountCurrentAgentTurn(
		ctx: ExtensionContext,
		mode: GoalAccountingMode,
		agentRunMessages?: unknown[],
	): Promise<Goal | null> {
		const accounting = agentGoalAccounting;
		const ref = goalStoreRef(ctx);
		if (accounting === null) return readGoal(ref);

		const usage =
			agentRunMessages === undefined ? turnUsage.takePending() : turnUsage.takeRemaining(agentRunMessages);
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

function goalStoreRef(ctx: ExtensionContext): GoalStoreRef {
	return buildGoalStoreRef(ctx.sessionManager, ctx.cwd);
}
