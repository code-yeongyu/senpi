import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Goal } from "./types.ts";

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultAgentMessage = Extract<AgentMessage, { role: "toolResult" }>;

export const GOAL_CONTINUATION_CAP = 8;
export const GOAL_STALL_TOOLLESS_THRESHOLD = 3;
export const GOAL_REPETITION_HASH_STREAK = 3;
export const GOAL_LENGTH_RECOVERY_LIMIT = 1;
export const GOAL_USER_GRACE_DELAY_MS = 10_000;

export type GoalContinuationPath = "immediate" | "monitorDelayed" | "userGrace" | "sessionStart";

export type GoalContinuationInput = {
	readonly goal: Goal | null;
	readonly isIdle: boolean;
	readonly hasPendingMessages: boolean;
	readonly path: GoalContinuationPath;
	readonly lastStopReason: AssistantAgentMessage["stopReason"] | undefined;
	readonly consecutiveContinuations: number;
	readonly lastContinuationSignature: string | undefined;
	readonly currentSignature: string | undefined;
	readonly consecutiveLengthRecoveries: number;
	readonly recentNormalizedOutputHashes: readonly string[];
	readonly toollessContinuationStreak: number;
	readonly continuationPending: boolean;
};

export type GoalContinuationVerdict =
	| { kind: "continue"; prompt: "full" | "minimal"; stallNotice: boolean }
	| {
			kind: "deny";
			reason: "not-eligible" | "single-flight" | "cap" | "stale" | "repetition" | "length-exhausted";
	  };

export function shouldQueueGoalContinuationWhenIdle(
	goal: Goal | null,
	isIdle: boolean,
	hasPendingMessages: boolean,
): goal is Goal {
	return goal?.status === "active" && isIdle && !hasPendingMessages;
}

export function shouldQueueGoalContinuationAfterAgentEnd(
	goal: Goal | null,
	hasPendingMessages: boolean,
	messages: readonly AgentMessage[],
): goal is Goal {
	return goal?.status === "active" && !hasPendingMessages && didAgentEndCleanly(messages);
}

function didAgentEndCleanly(messages: readonly AgentMessage[]): boolean {
	const lastAssistantIndex = findLastAssistantMessageIndex(messages);
	if (lastAssistantIndex === undefined) return false;

	const lastAssistant = messages[lastAssistantIndex];
	if (lastAssistant?.role !== "assistant" || !isContinuableStopReason(lastAssistant.stopReason)) return false;

	for (let index = lastAssistantIndex + 1; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role === "toolResult" && isAbortedToolResult(message)) return false;
	}
	return true;
}

function findLastAssistantMessageIndex(messages: readonly AgentMessage[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return index;
		}
	}
	return undefined;
}

function isContinuableStopReason(stopReason: AssistantAgentMessage["stopReason"]): boolean {
	return stopReason === "stop" || stopReason === "length";
}

function isAbortedToolResult(message: ToolResultAgentMessage): boolean {
	if (!message.isError) return false;
	return message.content.some((content) => content.type === "text" && /\babort(?:ed)?\b/i.test(content.text));
}

export function evaluateGoalContinuation(input: GoalContinuationInput): GoalContinuationVerdict {
	if (!isEligibleForGoalContinuation(input)) return { kind: "deny", reason: "not-eligible" };
	if (input.continuationPending) return { kind: "deny", reason: "single-flight" };
	if (hasRepeatedNormalizedOutputHash(input.recentNormalizedOutputHashes))
		return { kind: "deny", reason: "repetition" };
	if (input.consecutiveContinuations >= GOAL_CONTINUATION_CAP) {
		return { kind: "deny", reason: "cap" };
	}
	if (
		(input.path === "immediate" || input.path === "userGrace") &&
		input.lastContinuationSignature !== undefined &&
		input.lastContinuationSignature === input.currentSignature
	) {
		return { kind: "deny", reason: "stale" };
	}
	if (input.lastStopReason === "length") {
		if (input.consecutiveLengthRecoveries >= GOAL_LENGTH_RECOVERY_LIMIT) {
			return { kind: "deny", reason: "length-exhausted" };
		}
		return { kind: "continue", prompt: "minimal", stallNotice: shouldShowStallNotice(input) };
	}
	return { kind: "continue", prompt: "full", stallNotice: shouldShowStallNotice(input) };
}

/** Produces a stable, whitespace-insensitive representation for repetition detection. */
export function normalizeAssistantText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Hashes normalized assistant text with the deterministic 32-bit FNV-1a algorithm. */
export function hashAssistantText(text: string): string {
	const normalized = normalizeAssistantText(text);
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalized.length; index++) {
		hash ^= normalized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Identifies the observable goal progress for stale-continuation admission.
 * Deliberately excludes goal.updatedAt because usage accounting updates it after every agent turn.
 */
export function buildGoalContinuationSignature(
	goal: Pick<Goal, "id">,
	openTodos: number,
	totalTodos: number,
	lastAssistantTextHash: string,
): string {
	return `${goal.id}:${openTodos}/${totalTodos}:${lastAssistantTextHash}`;
}

export function hasGoalContinuationProgress(
	input: Pick<GoalContinuationInput, "lastContinuationSignature" | "currentSignature">,
): boolean {
	return (
		input.lastContinuationSignature !== undefined &&
		input.currentSignature !== undefined &&
		input.lastContinuationSignature !== input.currentSignature
	);
}

export function continuationTurnUsedTools(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => {
		if (message?.role === "toolResult") return true;
		return message?.role === "assistant" && message.content.some((content) => content.type === "toolCall");
	});
}

function isEligibleForGoalContinuation(input: GoalContinuationInput): boolean {
	if (input.goal?.status !== "active" || input.hasPendingMessages) return false;
	if (input.path === "immediate") {
		return input.lastStopReason !== undefined && isContinuableStopReason(input.lastStopReason);
	}
	return input.isIdle;
}

function hasRepeatedNormalizedOutputHash(hashes: readonly string[]): boolean {
	const latestHash = hashes.at(-1);
	if (latestHash === undefined) return false;

	let streak = 0;
	for (let index = hashes.length - 1; index >= 0 && hashes[index] === latestHash; index--) {
		streak += 1;
	}
	return streak >= GOAL_REPETITION_HASH_STREAK;
}

function shouldShowStallNotice(input: GoalContinuationInput): boolean {
	return input.toollessContinuationStreak >= GOAL_STALL_TOOLLESS_THRESHOLD;
}
