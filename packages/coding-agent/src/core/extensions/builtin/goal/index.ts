import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../messages.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "../../types.ts";
import { GOAL_CACHE_WARMUP_ENTRY_TYPE } from "./cache-warm.ts";
import { renderGoalCacheWarmupEntry } from "./cache-warm-renderer.ts";
import { registerGoalCommand } from "./command-registration.ts";
import { GOAL_CONTINUATION_CAP } from "./continuation.ts";
import { GoalElapsedTicker } from "./elapsed-ticker.ts";
import { queueGoalContinuation } from "./lifecycle-helpers.ts";
import { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
import type { GoalTurnTransition } from "./store.ts";
import { finalizeGoalTurn, readGoal, restoreContinuationStreak, updateGoal } from "./store.ts";
import { goalStoreRef as buildGoalStoreRef } from "./store-ref.ts";
import { staleGoalTodoReminder, todoResultAddsOpenTasks } from "./todo-gate.ts";
import { registerGoalTools } from "./tool-registration.ts";
import { TurnUsageTracker } from "./turn-usage.ts";
import type { Goal, GoalAccountingMode, GoalStoreRef } from "./types.ts";
import { updateGoalUi } from "./ui.ts";

const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

type AgentGoalAccounting = {
	goalId: string;
	measuredFromMilliseconds: number;
};

type AgentGoalTransition = GoalTurnTransition & {
	readonly goalId?: string;
};

export default function goalExtension(pi: ExtensionAPI): void {
	let agentTurnInProgress = false;
	let staleGoalReminderSentThisTurn = false;
	let agentGoalAccounting: AgentGoalAccounting | null = null;
	let blockedThisTurnGoalId: string | null = null;
	let completedThisTurnGoalId: string | null = null;
	let continuationPending = false;
	const turnUsage = new TurnUsageTracker();
	const monitorContinuation = new MonitorAwareGoalContinuation(
		pi,
		() => continuationPending,
		() => {
			continuationPending = true;
		},
	);

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
		queueGoalContinuation: (extensionApi, commandCtx, goal) =>
			queueGoalContinuationForCurrentSession(extensionApi, commandCtx, goal),
		refreshGoalUi,
	});

	pi.on("session_start", async (event, ctx) => {
		monitorContinuation.start(ctx);
		let goal = await readGoal(goalStoreRef(ctx));
		// Restore the persisted continuation budget from the already-materialized
		// branch before any startup continuation can be admitted.
		if (goal?.status === "active" && event.reason !== "reload") {
			const derivedCount = countGoalContinuationEntriesSince(ctx.sessionManager.getBranch(), goal.lastStartedAt);
			const recovered = await restoreContinuationStreak(
				goalStoreRef(ctx),
				goal,
				derivedCount,
				GOAL_CONTINUATION_CAP,
			);
			if (recovered.status === "paused") {
				pi.events?.emit("goal_continuation_guard_tripped", {
					goalId: recovered.id,
					reason: "cap",
					count: recovered.consecutiveContinuations ?? 0,
				});
				ctx.ui.notify(
					`Goal paused after recovering ${recovered.consecutiveContinuations ?? 0} historical continuations. Run /goal resume to continue.`,
					"info",
				);
			}
			goal = recovered;
		}
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		refreshGoalUi(ctx, goal);
		// A config reload must not auto-start an agent that was stopped. Only a fresh
		// startup or explicit /goal resume may re-engage an active goal.
		if (goal?.status === "active" && event.reason !== "reload") {
			await queueGoalContinuationForCurrentSession(pi, ctx, goal);
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		continuationPending = false;
		monitorContinuation.noteUserPrompt();
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status !== "active") return { action: "continue" };

		continuationPending = false;
		const paused = await accountCurrentAgentTurn(ctx, "active", undefined, {
			goalId: goal.id,
			status: "paused",
			source: "system",
			reason: "user-input",
			when: (candidate) => candidate.status === "active",
		});
		clearAgentGoalAccounting();
		refreshGoalUi(ctx, paused);
		emitGoalPauseTriggered(paused);
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		monitorContinuation.noteUserPrompt();
		const ref = goalStoreRef(ctx);
		let goal = await readGoal(ref);
		if (goal?.status === "blocked") {
			goal = await updateGoal(ref, { status: "active" }, "user");
		} else if (goal?.status === "active") {
			goal = await accountCurrentAgentTurn(ctx, "active", undefined, {
				goalId: goal.id,
				status: "paused",
				source: "system",
				reason: "user-input",
				when: (candidate) => candidate.status === "active",
			});
			clearAgentGoalAccounting();
		}
		if (goal !== null) refreshGoalUi(ctx, goal);
		emitGoalPauseTriggered(goal);
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
		if (goal !== null && isGoalAccountableDuringAgentTurn(goal)) {
			beginAgentGoalAccounting(goal);
		} else {
			agentGoalAccounting = null;
		}
	});

	pi.on("message_end", async (event) => {
		turnUsage.noteMessageEnd(event.message);
	});

	pi.on("agent_end", async (event, ctx) => {
		const userAborted = event.aborted === true && event.abortSource === "user";
		const terminalPauseReason = reasonForTerminalPause(event);
		const mode: GoalAccountingMode =
			blockedThisTurnGoalId !== null
				? "activeOrBlocked"
				: completedThisTurnGoalId === null
					? "activeOrUserPaused"
					: "activeOrComplete";
		const transition: AgentGoalTransition | undefined = userAborted
			? {
					status: "blocked",
					source: "model",
					reason: "user interrupted the turn",
					when: (candidate) =>
						candidate.status === "active" ||
						(candidate.status === "paused" && candidate.blockedReason === "user-input"),
				}
			: terminalPauseReason === undefined
				? undefined
				: {
						status: "paused",
						source: "system",
						reason: terminalPauseReason,
						when: (candidate) =>
							candidate.status === "active" ||
							(candidate.status === "paused" && candidate.blockedReason === "user-input"),
					};
		let goal = await accountCurrentAgentTurn(ctx, mode, event.messages, transition);
		agentTurnInProgress = false;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		refreshGoalUiBestEffort(ctx, goal);
		const continuationGoal = await monitorContinuation.afterAgentEnd({ ctx, goal, messages: event.messages });
		if (continuationGoal !== goal) {
			goal = continuationGoal;
			if (goal?.status === "active") {
				beginAgentGoalAccounting(goal);
			} else {
				clearAgentGoalAccounting();
			}
			refreshGoalUiBestEffort(ctx, goal);
		}
	});

	pi.on("session_abort", async (_event, ctx) => {
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status !== "active" && !(goal?.status === "paused" && goal.blockedReason === "user-input")) {
			return;
		}
		const blocked = await accountCurrentAgentTurn(ctx, "active", undefined, {
			goalId: goal.id,
			status: "blocked",
			source: "model",
			reason: "user interrupted the turn",
			when: (candidate) =>
				candidate.status === "active" ||
				(candidate.status === "paused" && candidate.blockedReason === "user-input"),
		});
		clearAgentGoalAccounting();
		refreshGoalUiBestEffort(ctx, blocked);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (agentGoalAccounting !== null) {
			await accountCurrentAgentTurn(ctx, "activeOrUserPaused");
		}
		clearAgentGoalAccounting();
		goalTicker.stop();
		monitorContinuation.dispose();
	});

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
		if (!isGoalAccountableDuringAgentTurn(goal)) return;
		if (agentGoalAccounting?.goalId === goal.id) return;
		turnUsage.discardPending();
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function emitGoalPauseTriggered(goal: Goal | null): void {
		if (goal?.status !== "paused" || goal.blockedReason !== "user-input") return;
		pi.events?.emit("goal_pause_triggered", { goalId: goal.id, reason: "user-input" });
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
		transition?: AgentGoalTransition,
	): Promise<Goal | null> {
		const accounting = agentGoalAccounting;
		const ref = goalStoreRef(ctx);
		if (accounting === null && transition === undefined) return readGoal(ref);

		const usage =
			accounting === null
				? undefined
				: agentRunMessages === undefined
					? turnUsage.takePending()
					: turnUsage.takeRemaining(agentRunMessages);
		const now = Date.now();
		const elapsedSeconds =
			accounting === null ? 0 : Math.max(0, Math.round((now - accounting.measuredFromMilliseconds) / 1000));
		const goal = await finalizeGoalTurn(ref, {
			usage,
			elapsedSeconds,
			mode,
			expectedGoalId: transition?.goalId ?? accounting?.goalId,
			transition,
		});
		if (accounting !== null) {
			if (goal?.id === accounting.goalId) {
				agentGoalAccounting = { goalId: accounting.goalId, measuredFromMilliseconds: now };
			} else {
				clearAgentGoalAccounting();
			}
		}
		return goal;
	}
}

/** Counts current-segment continuations in one pass over the caller's in-memory branch. */
function countGoalContinuationEntriesSince(
	entries: readonly SessionEntry[],
	lastStartedAt: number | undefined,
): number {
	const sinceMilliseconds = lastStartedAt === undefined ? undefined : lastStartedAt * 1000;
	let count = 0;
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== GOAL_CONTINUATION_MESSAGE_TYPE) continue;
		if (sinceMilliseconds !== undefined) {
			const entryMilliseconds = Date.parse(entry.timestamp);
			if (!Number.isNaN(entryMilliseconds) && entryMilliseconds < sinceMilliseconds) continue;
		}
		count += 1;
	}
	return count;
}

function isGoalAccountableDuringAgentTurn(goal: Goal): boolean {
	return goal.status === "active" || (goal.status === "paused" && goal.blockedReason === "user-input");
}

function reasonForTerminalPause(event: AgentEndEvent): string | undefined {
	if (event.aborted === true && event.abortSource !== "user" && event.willRetry === false) return "system abort";
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "length") return "output length";
		if (message.stopReason === "error" && event.willRetry === false) return "terminal provider error";
		return undefined;
	}
	return undefined;
}

function goalStoreRef(ctx: ExtensionContext): GoalStoreRef {
	return buildGoalStoreRef(ctx.sessionManager, ctx.cwd);
}
