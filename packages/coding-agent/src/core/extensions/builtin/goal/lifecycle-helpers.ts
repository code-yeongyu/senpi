import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../messages.ts";
import type { SessionEntry } from "../../../session-manager.ts";
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
	CONTINUATION_CAP_BLOCKED_REASON,
	continuationCapRecoveryHint,
	LENGTH_EXHAUSTED_BLOCKED_REASON,
	REPETITION_BLOCKED_REASON,
} from "./continuation-recovery.ts";
import { buildContinuationPrompt } from "./prompt.ts";
import { recordContinuationDelivered, updateGoal } from "./store.ts";
import { goalStoreRef } from "./store-ref.ts";
import { openTodoTaskContents } from "./todo-gate.ts";
import type { Goal } from "./types.ts";

type ContinuingGoalContinuationVerdict = Extract<GoalContinuationVerdict, { kind: "continue" }>;

type GoalContinuationDeliveryOptions = {
	readonly input: Omit<GoalContinuationInput, "goal">;
	readonly content: (verdict: ContinuingGoalContinuationVerdict) => string;
	readonly markContinuationPending: () => void;
};

export type SessionStartContinuationOptions = {
	readonly continuationPending: boolean;
	readonly markContinuationPending: () => void;
};

export function isResumeOfPausedGoal(
	ctx: ExtensionContext,
	sessionStartReason: string,
	goal: Goal | null,
): goal is Goal {
	return (
		sessionStartReason === "resume" &&
		goal?.status === "paused" &&
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
): Promise<Goal> {
	const verdict = evaluateGoalContinuation({ goal, ...options.input });
	if (verdict.kind === "deny") return handleDeniedContinuation(pi, ctx, goal, options.input, verdict.reason);

	if (options.input.currentSignature === undefined) {
		throw new Error("Cannot queue a goal continuation without a progress signature");
	}
	options.markContinuationPending();
	const recordedGoal = await recordContinuationDelivered(
		goalStoreRef(ctx.sessionManager, ctx.cwd),
		options.input.currentSignature,
	);
	if (recordedGoal === null) throw new Error("Cannot persist goal continuation delivery without an active goal");
	queueHiddenGoalPrompt(pi, options.content(verdict));
	return recordedGoal;
}

/** Routes startup and resume continuations through the same verdict and delivery accounting as agent-end paths. */
export async function queueGoalContinuation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: Goal,
	options: SessionStartContinuationOptions,
): Promise<Goal> {
	const signature = buildCurrentGoalContinuationSignature(
		ctx,
		goal,
		lastAssistantTextFromEntries(ctx.sessionManager.getBranch()),
	);
	return admitAndQueueGoalContinuation(pi, ctx, goal, {
		input: {
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			path: "sessionStart",
			lastStopReason: undefined,
			consecutiveContinuations: goal.consecutiveContinuations ?? 0,
			lastContinuationSignature: goal.lastContinuationSignature,
			currentSignature: signature,
			consecutiveLengthRecoveries: 0,
			recentNormalizedOutputHashes: [],
			toollessContinuationStreak: 0,
			continuationPending: options.continuationPending,
		},
		content: () => buildContinuationPrompt(goal),
		markContinuationPending: options.markContinuationPending,
	});
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

function lastAssistantTextFromEntries(entries: readonly SessionEntry[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") return textContent(entry.message);
	}
	return "";
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
): Promise<Goal> {
	const blockedReason = blockedReasonForContinuationGuard(reason);
	if (blockedReason === undefined) return goal;

	const blocked = await updateGoal(
		goalStoreRef(ctx.sessionManager, ctx.cwd),
		{ status: "blocked", reason: blockedReason },
		"model",
	);
	if (ctx.hasUI) ctx.ui.notify(continuationCapRecoveryHint(blockedReason), "warning");
	pi.events?.emit("goal_continuation_guard_tripped", {
		goalId: goal.id,
		reason,
		count: input.consecutiveContinuations,
	});
	return blocked;
}

function blockedReasonForContinuationGuard(
	reason: Extract<GoalContinuationVerdict, { kind: "deny" }>["reason"],
): string | undefined {
	switch (reason) {
		case "cap":
			return CONTINUATION_CAP_BLOCKED_REASON;
		case "repetition":
			return REPETITION_BLOCKED_REASON;
		case "length-exhausted":
			return LENGTH_EXHAUSTED_BLOCKED_REASON;
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
