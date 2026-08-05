import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../messages.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { continueGoalAfterAgentEnd } from "./agent-end-continuation.ts";
import { GOAL_CACHE_WARMUP_ENTRY_TYPE } from "./cache-warm.ts";
import { renderGoalCacheWarmupEntry } from "./cache-warm-renderer.ts";
import { registerGoalCommand } from "./command-registration.ts";
import { GOAL_CONTINUATION_CAP } from "./continuation.ts";
import { continuationCapRecoveryHint, PROVIDER_ERROR_BLOCKED_REASON } from "./continuation-recovery.ts";
import { GoalDirectInputLifecycle } from "./direct-input-lifecycle.ts";
import { GoalElapsedTicker } from "./elapsed-ticker.ts";
import { formatGoalForTool, goalStatusLabel } from "./format.ts";
import { isResumeOfStoppedGoal, queueGoalContinuation } from "./lifecycle-helpers.ts";
import { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
import { migrateLegacyGoalFile } from "./persistence.ts";
import { accountGoalUsage, readGoal, updateGoal } from "./store.ts";
import { goalStoreRef as buildGoalStoreRef } from "./store-ref.ts";
import { didTerminalProviderErrorEndTurn } from "./terminal-provider-error.ts";
import { staleGoalTodoReminder, todoResultAddsOpenTasks } from "./todo-gate.ts";
import { registerGoalTools } from "./tool-registration.ts";
import { TurnUsageTracker } from "./turn-usage.ts";
import type { Goal, GoalAccountingMode, GoalStoreRef } from "./types.ts";
import { updateGoalUi } from "./ui.ts";
import { GOAL_WAIT_STATUS_KEY, GoalWaitTicker } from "./wait-ticker.ts";

const RESUME_GOAL_CHOICE = "Resume goal";
const LEAVE_GOAL_STOPPED_CHOICE = "Leave stopped";
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

type AgentGoalAccounting = {
	goalId: string;
	measuredFromMilliseconds: number;
};

export default function goalExtension(pi: ExtensionAPI): void {
	let agentTurnInProgress = false;
	let staleGoalReminderSentThisTurn = false;
	let agentGoalAccounting: AgentGoalAccounting | null = null;
	let blockedThisTurnGoalId: string | null = null;
	let completedThisTurnGoalId: string | null = null;
	let continuationPending = false;
	const turnUsage = new TurnUsageTracker();
	const goalWaitTicker = new GoalWaitTicker({
		render: (renderCtx, status) => {
			try {
				renderCtx.ui.setStatus(GOAL_WAIT_STATUS_KEY, status);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)) return;
				throw error;
			}
		},
	});
	const monitorContinuation = new MonitorAwareGoalContinuation(
		pi,
		() => continuationPending,
		() => {
			continuationPending = true;
		},
		goalWaitTicker,
	);
	const directInputLifecycle = new GoalDirectInputLifecycle({
		monitor: monitorContinuation,
		goalStoreRef,
		beginAgentGoalAccounting,
		refreshGoalUi: refreshGoalUiBestEffort,
	});

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

	pi.registerEntryRenderer(GOAL_CACHE_WARMUP_ENTRY_TYPE, renderGoalCacheWarmupEntry);
	registerGoalTools(pi, {
		goalStoreRef: (ctx) => buildGoalStoreRef(ctx.sessionManager, ctx.cwd),
		accountCurrentAgentTurn,
		beginAgentGoalAccounting: (goal) => {
			monitorContinuation.noteContinuationStarted();
			beginAgentGoalAccounting(goal);
		},
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
		queueGoalContinuation: (extensionApi, commandCtx, goal) => {
			void queueGoalContinuationForCurrentSession(extensionApi, commandCtx, goal);
		},
		refreshGoalUi,
	});

	pi.on("session_start", async (event, ctx) => {
		monitorContinuation.start(ctx);
		directInputLifecycle.reset();
		const ref = goalStoreRef(ctx);
		await migrateLegacyGoalFile(ref);
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		refreshGoalUi(ctx, goal);
		if (await maybePromptResumeStoppedGoal(pi, ctx, event.reason, goal)) {
			return;
		}
		// A config reload must not auto-start an agent that was stopped. Only a fresh
		// startup or explicit resume may re-engage an active goal via a continuation.
		if (goal && event.reason !== "reload") {
			// Migration-lite admission: a resumed session carrying a trailing flood of
			// historical continuations must not reignite on load. Skip the auto-queue,
			// leave the goal active (no status rewrite), and tell the user how to resume.
			const trailingContinuations = countTrailingGoalContinuationEntries(ctx.sessionManager.getBranch());
			if (trailingContinuations >= GOAL_CONTINUATION_CAP) {
				ctx.ui.notify(
					`Goal auto-continuation suppressed for this resumed session (${trailingContinuations} historical continuations). Send a message to resume.`,
					"info",
				);
			} else {
				await queueGoalContinuationForCurrentSession(pi, ctx, goal);
			}
		}
	});

	pi.on("input", async (event, ctx) => {
		await directInputLifecycle.onInput(event, ctx);
	});

	pi.on("input_disposition", async (event, ctx) => {
		await directInputLifecycle.onDisposition(event, ctx);
	});

	pi.on("turn_start", async () => {
		staleGoalReminderSentThisTurn = false;
	});

	// When the model starts tracking new open todo work while the thread has no
	// goal (or only a stale, already-complete one), append a system reminder to
	// the todo result so the model registers the goal when the work warrants it.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "todo" || event.isError || staleGoalReminderSentThisTurn) return undefined;
		if (!todoResultAddsOpenTasks(event.details)) return undefined;
		const reminder = staleGoalTodoReminder(await readGoal(goalStoreRef(ctx)));
		if (reminder === undefined) return undefined;
		staleGoalReminderSentThisTurn = true;
		return { content: [...event.content, { type: "text" as const, text: reminder }] };
	});

	pi.on("agent_start", async (_event, ctx) => {
		const continuationStarted = continuationPending;
		continuationPending = false;
		if (continuationStarted) monitorContinuation.noteContinuationStarted();
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
		} else if (didTerminalProviderErrorEndTurn(event) && goal?.status === "active") {
			goal = await updateGoal(
				goalStoreRef(ctx),
				{ status: "blocked", reason: PROVIDER_ERROR_BLOCKED_REASON },
				"model",
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}\n${continuationCapRecoveryHint(PROVIDER_ERROR_BLOCKED_REASON)}`,
					"warning",
				);
			}
		}
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		refreshGoalUiBestEffort(ctx, goal);
		const continuationGoal = await continueGoalAfterAgentEnd(monitorContinuation, { ctx, event, goal });
		if (continuationGoal !== goal) {
			goal = continuationGoal;
			syncContinuationGoal(ctx, goal);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const goal = await monitorContinuation.afterAgentSettled();
		if (goal !== undefined) syncContinuationGoal(ctx, goal);
	});

	pi.on("session_abort", async (_event, ctx) => {
		continuationPending = false;
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status !== "active") return;
		const accounted = await accountCurrentAgentTurn(ctx, "active");
		if (accounted?.status === "active") {
			const blocked = await updateGoal(
				goalStoreRef(ctx),
				{ status: "blocked", reason: "user interrupted the turn" },
				"model",
			);
			clearAgentGoalAccounting();
			refreshGoalUiBestEffort(ctx, blocked);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (agentGoalAccounting !== null) {
			await accountCurrentAgentTurn(ctx, "active");
		}
		clearAgentGoalAccounting();
		goalTicker.stop();
		monitorContinuation.dispose();
	});

	async function maybePromptResumeStoppedGoal(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		sessionStartReason: string,
		goal: Goal | null,
	): Promise<boolean> {
		if (!isResumeOfStoppedGoal(ctx, sessionStartReason, goal)) {
			return false;
		}

		const choice = await ctx.ui.select(`Resume ${goal.status} goal?\nGoal: ${goal.objective}`, [
			RESUME_GOAL_CHOICE,
			LEAVE_GOAL_STOPPED_CHOICE,
		]);
		if (choice !== RESUME_GOAL_CHOICE) return true;

		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		beginAgentGoalAccounting(resumed);
		refreshGoalUi(ctx, resumed);
		ctx.ui.notify(`Goal ${goalStatusLabel(resumed.status)}\n${formatGoalForTool(resumed)}`, "info");
		await queueGoalContinuationForCurrentSession(pi, ctx, resumed);
		return true;
	}

	async function queueGoalContinuationForCurrentSession(
		extensionApi: ExtensionAPI,
		ctx: ExtensionContext,
		goal: Goal,
	): Promise<void> {
		const continuedGoal = await queueGoalContinuation(extensionApi, ctx, goal, {
			continuationPending,
			markContinuationPending: () => {
				continuationPending = true;
			},
		});
		if (continuedGoal.status === goal.status) return;
		if (continuedGoal.status === "active") beginAgentGoalAccounting(continuedGoal);
		else clearAgentGoalAccounting();
		refreshGoalUiBestEffort(ctx, continuedGoal);
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

	function syncContinuationGoal(ctx: ExtensionContext, goal: Goal | null): void {
		if (goal?.status === "active") beginAgentGoalAccounting(goal);
		else clearAgentGoalAccounting();
		refreshGoalUiBestEffort(ctx, goal);
	}

	function refreshGoalUi(ctx: ExtensionContext, goal: Goal | null): void {
		monitorContinuation.syncGoal(goal);
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

/**
 * Counts goal-continuation entries queued since the most recent real user message
 * in the current branch (mirrors the todo-gate / todo-bridge backward branch read).
 * A real user message is the only reset: the assistant turns in between are exactly
 * the unattended loop this admission guard exists to stop.
 */
function countTrailingGoalContinuationEntries(entries: readonly SessionEntry[]): number {
	let count = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "user") break;
		if (entry?.type === "custom_message" && entry.customType === GOAL_CONTINUATION_MESSAGE_TYPE) count += 1;
	}
	return count;
}

function goalStoreRef(ctx: ExtensionContext): GoalStoreRef {
	return buildGoalStoreRef(ctx.sessionManager, ctx.cwd);
}
