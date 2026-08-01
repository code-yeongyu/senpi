import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../messages.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext, MessageDelivery } from "../../types.ts";
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
import {
	readObjectiveForPrompt,
	recordContinuationDelivered,
	rollbackContinuationDelivered,
	updateGoal,
} from "./store.ts";
import { goalStoreRef } from "./store-ref.ts";
import { openTodoTaskContents } from "./todo-gate.ts";
import type { Goal } from "./types.ts";

type ContinuingGoalContinuationVerdict = Extract<GoalContinuationVerdict, { kind: "continue" }>;

type ReservedMessageDelivery = MessageDelivery & {
	readonly cancelled: boolean;
	bind(delivery: MessageDelivery): boolean;
};

export type GoalContinuationDeliveryOutcome = {
	readonly goal: Goal;
	readonly admitted: boolean;
	readonly delivery?: MessageDelivery;
};

type DeliveryState = "pending" | "started" | "cancelled";

let nextReservationId = 0;

function reserveMessageDelivery(): ReservedMessageDelivery {
	let actual: MessageDelivery | undefined;
	let state: DeliveryState = "pending";
	const startedListeners = new Set<() => void>();
	const cancelledListeners = new Set<() => void>();
	const isCancelled = (): boolean => state === "cancelled";
	const settle = (nextState: Exclude<DeliveryState, "pending">): void => {
		if (state !== "pending") return;
		state = nextState;
		const listeners = nextState === "started" ? startedListeners : cancelledListeners;
		for (const listener of listeners) listener();
		startedListeners.clear();
		cancelledListeners.clear();
	};
	return {
		id: `goal-continuation-reservation-${++nextReservationId}`,
		get cancelled() {
			return isCancelled();
		},
		cancel() {
			if (state !== "pending") return false;
			if (actual !== undefined && !actual.cancel()) return false;
			settle("cancelled");
			return true;
		},
		onStarted(listener) {
			if (state === "started") {
				listener();
				return () => {};
			}
			if (state !== "pending") return () => {};
			startedListeners.add(listener);
			return () => startedListeners.delete(listener);
		},
		onCancelled(listener) {
			if (state === "cancelled") {
				listener();
				return () => {};
			}
			if (state !== "pending") return () => {};
			cancelledListeners.add(listener);
			return () => cancelledListeners.delete(listener);
		},
		bind(delivery) {
			if (state !== "pending") {
				delivery.cancel();
				return false;
			}
			actual = delivery;
			delivery.onStarted(() => settle("started"));
			delivery.onCancelled(() => settle("cancelled"));
			return !isCancelled();
		},
	};
}

type GoalContinuationDeliveryOptions = {
	readonly input: Omit<GoalContinuationInput, "goal">;
	readonly content: (verdict: ContinuingGoalContinuationVerdict) => string | Promise<string>;
	readonly markContinuationPending: (delivery: MessageDelivery) => void;
};

export type SessionStartContinuationOptions = {
	readonly continuationPending: boolean;
	readonly markContinuationPending: (delivery: MessageDelivery) => void;
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
): Promise<GoalContinuationDeliveryOutcome> {
	const verdict = evaluateGoalContinuation({ goal, ...options.input });
	if (verdict.kind === "deny") {
		return { goal: await handleDeniedContinuation(pi, ctx, goal, options.input, verdict.reason), admitted: false };
	}

	if (options.input.currentSignature === undefined) {
		throw new Error("Cannot queue a goal continuation without a progress signature");
	}
	const reservation = reserveMessageDelivery();
	options.markContinuationPending(reservation);
	try {
		const content = await options.content(verdict);
		if (reservation.cancelled) return { goal, admitted: false };
		const recordedGoal = await recordContinuationDelivered(
			goalStoreRef(ctx.sessionManager, ctx.cwd),
			options.input.currentSignature,
			goalContinuationExpectation(goal),
		);
		if (recordedGoal === null) {
			reservation.cancel();
			return { goal, admitted: false };
		}
		reservation.onCancelled(() => {
			void rollbackContinuationDelivered(
				goalStoreRef(ctx.sessionManager, ctx.cwd),
				goal,
				options.input.currentSignature ?? "",
			).then(
				(rolledBack) => {
					if (rolledBack !== null) {
						pi.events?.emit("goal_continuation_delivery_rolled_back", { goalId: goal.id });
					}
				},
				(error) => {
					pi.events?.emit("goal_continuation_delivery_rollback_failed", {
						goalId: goal.id,
						error: error instanceof Error ? error.message : String(error),
					});
				},
			);
		});
		if (reservation.cancelled) return { goal: recordedGoal, admitted: false };
		const admitted = reservation.bind(queueHiddenGoalPrompt(pi, content));
		return {
			goal: recordedGoal,
			admitted,
			...(admitted ? { delivery: reservation } : {}),
		};
	} catch (error) {
		reservation.cancel();
		throw error;
	}
}

/** Routes startup and resume continuations through the same verdict and delivery accounting as agent-end paths. */
export async function queueGoalContinuation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: Goal,
	options: SessionStartContinuationOptions,
): Promise<Goal> {
	const ref = goalStoreRef(ctx.sessionManager, ctx.cwd);
	const objective = await readObjectiveForPrompt(ref, goal);
	const signature = buildCurrentGoalContinuationSignature(
		ctx,
		goal,
		lastAssistantTextFromEntries(ctx.sessionManager.getBranch()),
	);
	const outcome = await admitAndQueueGoalContinuation(pi, ctx, goal, {
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
		content: () => buildContinuationPrompt(goal, objective),
		markContinuationPending: options.markContinuationPending,
	});
	return outcome.goal;
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
		goalContinuationExpectation(goal),
	);
	if (blocked === null) return goal;
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

function goalContinuationExpectation(goal: Goal) {
	return {
		id: goal.id,
		status: goal.status,
		continuation: {
			consecutiveContinuations: goal.consecutiveContinuations ?? 0,
			lastContinuationSignature: goal.lastContinuationSignature,
		},
	} as const;
}

export function queueHiddenGoalPrompt(pi: ExtensionAPI, content: string): MessageDelivery {
	return pi.sendMessage(
		{ customType: GOAL_CONTINUATION_MESSAGE_TYPE, content, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
