import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isTurnStuckOnContextOverflow } from "../../../compaction/stuck-overflow.ts";
import { ENGINE_PAUSED_ENTRY_TYPE, enginePauseSinceLastTurn } from "../../../engine-paused.ts";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../messages.ts";
import { createSessionLogger } from "../../../session-log.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import { isRecord } from "../../../work-custody-record.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { getLatestPhasesFromBranchEntries } from "../todotools/state.ts";
import {
	buildGoalContinuationSignature,
	evaluateGoalContinuation,
	type GoalContinuationInput,
	type GoalContinuationVerdict,
	hashAssistantText,
} from "./continuation.ts";
import {
	CONTEXT_OVERFLOW_BLOCKED_REASON,
	CONTINUATION_CAP_BLOCKED_REASON,
	continuationCapRecoveryHint,
	LENGTH_EXHAUSTED_BLOCKED_REASON,
	NO_PROGRESS_BLOCKED_REASON,
	REPETITION_BLOCKED_REASON,
} from "./continuation-recovery.ts";
import { recordContinuationDelivered, recordGoalContinuationStopped } from "./store.ts";
import { goalStoreRef } from "./store-ref.ts";
import { openTodoTaskContents } from "./todo-gate.ts";
import type { Goal } from "./types.ts";

type ContinuingGoalContinuationVerdict = Extract<GoalContinuationVerdict, { kind: "continue" }>;

export const GOAL_STALE_STOP_NOTICE =
	"Goal auto-continuation stopped because progress is stale. Send a message or run /goal resume to continue.";

type GoalContinuationDeliveryOptions = {
	readonly input: Omit<GoalContinuationInput, "goal">;
	readonly content: (verdict: ContinuingGoalContinuationVerdict) => string;
	readonly markContinuationPending: () => void;
};

/**
 * Statuses that leave a goal stopped without finishing it. A restart is the only
 * moment the user can act on them, so both earn the resume prompt.
 */
const STOPPED_UNFINISHED_GOAL_STATUSES: readonly Goal["status"][] = ["paused", "blocked"];

/**
 * Mirrors codex `maybe_prompt_resume_paused_goal_after_resume`
 * (codex-rs/tui/src/app/thread_goal_actions.rs), which prompts on resume for every
 * stopped-but-unfinished status. senpi is budget-free, so codex's `UsageLimited`
 * has no counterpart here and the stopped set is `paused | blocked`.
 */
export function isResumeOfStoppedGoal(
	ctx: ExtensionContext,
	sessionStartReason: string,
	goal: Goal | null,
): goal is Goal {
	return (
		sessionStartReason === "resume" &&
		goal !== null &&
		STOPPED_UNFINISHED_GOAL_STATUSES.includes(goal.status) &&
		ctx.hasUI &&
		ctx.isIdle() &&
		!ctx.hasPendingMessages()
	);
}

/** Evaluates and delivers a continuation only after all guardrail checks admit it. */
export async function admitAndQueueGoalContinuation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: Goal,
	options: GoalContinuationDeliveryOptions,
): Promise<Goal | null> {
	if (goal.status === "active" && ctx.engineTurnsHeld?.()) {
		ctx.noteHeldWake?.("goal");
		return goal;
	}
	const verdict = evaluateGoalContinuation({ goal, ...options.input });
	if (verdict.kind === "deny") return handleDeniedContinuation(pi, ctx, goal, options.input, verdict.reason);

	if (options.input.currentSignature === undefined) {
		throw new Error("Cannot queue a goal continuation without a progress signature");
	}
	const recordedGoal = await recordContinuationDelivered(
		goalStoreRef(ctx.sessionManager, ctx.cwd),
		options.input.currentSignature,
		goal.id,
		options.input.limitWait === true
			? { countUnattended: false, countStreak: false }
			: { countUnattended: options.input.path !== "monitorDelayed" },
	);
	if (recordedGoal === null) return null;
	options.markContinuationPending();
	queueHiddenGoalPrompt(pi, options.content(verdict));
	return recordedGoal;
}

export function buildCurrentGoalContinuationSignature(
	ctx: ExtensionContext,
	goal: Goal,
	lastAssistantText: string,
): string {
	const entries = ctx.sessionManager.getBranch();
	const openTodos = openTodoTaskContents(entries).length;
	const totalTodos = getLatestPhasesFromBranchEntries(entries).reduce((count, phase) => count + phase.tasks.length, 0);
	return buildGoalContinuationSignature(goal, openTodos, totalTodos, hashAssistantText(lastAssistantText));
}

export function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return textContent(message);
	}
	return "";
}

export function isLastTurnStuckOnContextOverflow(
	ctx: ExtensionContext,
	lastAssistant: Extract<AgentMessage, { role: "assistant" }> | undefined,
): boolean {
	return lastAssistant !== undefined && isTurnStuckOnContextOverflow(lastAssistant, ctx.model?.contextWindow ?? 0);
}

function textContent(message: Extract<AgentMessage, { role: "assistant" }>): string {
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

async function handleDeniedContinuation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: Goal,
	input: Omit<GoalContinuationInput, "goal">,
	reason: Extract<GoalContinuationVerdict, { kind: "deny" }>["reason"],
): Promise<Goal | null> {
	if (goal.status !== "active" || reason === "not-eligible" || reason === "single-flight") return goal;
	const logger = createSessionLogger(ctx.agentDir);
	const at = Date.now();
	const blockedReason = blockedReasonForContinuationGuard(reason);
	const stopped = await recordGoalContinuationStopped(
		goalStoreRef(ctx.sessionManager, ctx.cwd),
		goal,
		at,
		blockedReason,
		{
			reason,
			consecutiveContinuations: input.consecutiveContinuations,
			unattendedContinuations: goal.unattendedContinuations ?? 0,
			noProgressContinuations: goal.noProgressContinuations ?? 0,
		},
	);
	if (!stopped.recorded) return stopped.goal;
	// Preserve the guard's existing side effects even if publishing the additive entries fails.
	if (reason === "stale" && ctx.hasUI) ctx.ui.notify(GOAL_STALE_STOP_NOTICE, "info");
	if (blockedReason !== undefined) {
		if (ctx.hasUI) ctx.ui.notify(continuationCapRecoveryHint(blockedReason), "warning");
		pi.events?.emit("goal_continuation_guard_tripped", {
			goalId: goal.id,
			reason,
			count: input.consecutiveContinuations,
			unattendedContinuations: goal.unattendedContinuations ?? 0,
			noProgressContinuations: goal.noProgressContinuations ?? 0,
		});
	}
	try {
		pi.appendEntry("goal-continuation-stopped", {
			goalId: goal.id,
			reason,
			consecutiveContinuations: input.consecutiveContinuations,
			unattendedContinuations: goal.unattendedContinuations ?? 0,
			noProgressContinuations: goal.noProgressContinuations ?? 0,
			at,
		});
	} catch (error) {
		logger.warn("goal_continuation_record_write_failed", {
			kind: "goal-continuation-stopped",
			error: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		if (
			(reason === "stale" || reason === "repetition") &&
			!enginePauseSinceLastTurn(ctx.sessionManager.getBranch())
		) {
			pi.appendEntry("engine-paused", {
				reason: reason === "stale" ? "goal-stale" : "goal-repeat",
				customType: GOAL_CONTINUATION_MESSAGE_TYPE,
				count: input.consecutiveContinuations,
				at,
			});
		}
	} catch (error) {
		logger.warn("goal_continuation_record_write_failed", {
			kind: "engine-paused",
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return stopped.goal;
}

/**
 * senpi#3015: the stop claim and the session entries are two separate writes, so a crash
 * between them leaves the claim without its entries. On session start the claim still
 * stands, so re-append the missing entries once from the payload the claim captured.
 * A claim whose entries already landed is left alone; a claim recorded before the
 * payload existed cannot be rebuilt and is left alone too.
 */
export async function recoverMissingGoalContinuationStop(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: Goal,
): Promise<void> {
	const at = goal.continuationStoppedAt;
	const detail = goal.continuationStoppedDetail;
	if (at === undefined || detail === undefined) return;
	const branch = ctx.sessionManager.getBranch();
	const logger = createSessionLogger(ctx.agentDir);
	if (!hasStopEntrySince(branch, goal.id, at)) {
		try {
			pi.appendEntry("goal-continuation-stopped", {
				goalId: goal.id,
				reason: detail.reason,
				consecutiveContinuations: detail.consecutiveContinuations,
				unattendedContinuations: detail.unattendedContinuations,
				noProgressContinuations: detail.noProgressContinuations,
				at,
			});
		} catch (error) {
			logger.warn("goal_continuation_record_write_failed", {
				kind: "goal-continuation-stopped",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (detail.reason !== "stale" && detail.reason !== "repetition") return;
	if (hasEnginePausedEntrySince(branch, at) || enginePauseSinceLastTurn(branch)) return;
	try {
		pi.appendEntry(ENGINE_PAUSED_ENTRY_TYPE, {
			reason: detail.reason === "stale" ? "goal-stale" : "goal-repeat",
			customType: GOAL_CONTINUATION_MESSAGE_TYPE,
			count: detail.consecutiveContinuations,
			at,
		});
	} catch (error) {
		logger.warn("goal_continuation_record_write_failed", {
			kind: ENGINE_PAUSED_ENTRY_TYPE,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function hasStopEntrySince(branch: readonly SessionEntry[], goalId: string, sinceAt: number): boolean {
	return branch.some(
		(entry) =>
			entry?.type === "custom" &&
			entry.customType === "goal-continuation-stopped" &&
			isRecord(entry.data) &&
			entry.data.goalId === goalId &&
			typeof entry.data.at === "number" &&
			entry.data.at >= sinceAt,
	);
}

function hasEnginePausedEntrySince(branch: readonly SessionEntry[], sinceAt: number): boolean {
	return branch.some(
		(entry) =>
			entry?.type === "custom" &&
			entry.customType === ENGINE_PAUSED_ENTRY_TYPE &&
			isRecord(entry.data) &&
			typeof entry.data.at === "number" &&
			entry.data.at >= sinceAt,
	);
}

function blockedReasonForContinuationGuard(
	reason: Extract<GoalContinuationVerdict, { kind: "deny" }>["reason"],
): string | undefined {
	switch (reason) {
		case "cap":
			return CONTINUATION_CAP_BLOCKED_REASON;
		case "no-progress":
			return NO_PROGRESS_BLOCKED_REASON;
		case "repetition":
			return REPETITION_BLOCKED_REASON;
		case "length-exhausted":
			return LENGTH_EXHAUSTED_BLOCKED_REASON;
		case "context-overflow":
			return CONTEXT_OVERFLOW_BLOCKED_REASON;
		case "not-eligible":
		case "single-flight":
		case "stale":
			return undefined;
	}
}

export function queueHiddenGoalPrompt(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{ customType: GOAL_CONTINUATION_MESSAGE_TYPE, content, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
