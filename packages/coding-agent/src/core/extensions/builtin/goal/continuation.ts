import { type AgentMessage, EMPTY_TOOL_USE_DEMOTION_DIAGNOSTIC } from "@earendil-works/pi-agent-core";
import type { Goal } from "./types.ts";

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultAgentMessage = Extract<AgentMessage, { role: "toolResult" }>;

export const GOAL_CONTINUATION_CAP = 8;
export const GOAL_STALL_TOOLLESS_THRESHOLD = 3;
export const GOAL_REPETITION_HASH_STREAK = 3;
export const GOAL_LENGTH_RECOVERY_LIMIT = 1;
/**
 * Consecutive automatic continuations without progress before the goal blocks (omo#10280).
 * Progress is a tool-using turn, a changed todo state, or new human input (direct, or a
 * human-input monitor delivery); varied narration alone is not. Measured across 593 goal
 * sessions (30 days): toolless stretches that recovered into tool use peaked at 29 (p99 7);
 * the #1139 stall ran 122. 60 is twice the measured peak, above the #447 pin (50).
 */
export const GOAL_NO_PROGRESS_CONTINUATION_LIMIT = 60;
export const GOAL_USER_GRACE_DELAY_MS = 10_000;

export type GoalContinuationPath =
	| "immediate"
	| "monitorDelayed"
	| "userGrace"
	| "sessionStart"
	| "systemRecovery"
	| "providerRecovery";

export type GoalContinuationInput = {
	readonly goal: Goal | null;
	readonly isIdle: boolean;
	readonly hasPendingMessages: boolean;
	readonly path: GoalContinuationPath;
	readonly lastStopReason: AssistantAgentMessage["stopReason"] | undefined;
	readonly lastTurnWasMalformedToolUse: boolean;
	readonly consecutiveContinuations: number;
	readonly lastContinuationSignature: string | undefined;
	readonly currentSignature: string | undefined;
	readonly consecutiveLengthRecoveries: number;
	readonly recentNormalizedOutputHashes: readonly string[];
	readonly toollessContinuationStreak: number;
	readonly continuationPending: boolean;
	/** The last turn was rejected (or silently starved) by context size and recovery did not shrink it. */
	readonly lastTurnStuckOnContextOverflow: boolean;
};

export type GoalContinuationVerdict =
	| { kind: "continue"; prompt: "full" | "minimal"; stallNotice: boolean }
	| {
			kind: "deny";
			reason:
				| "not-eligible"
				| "single-flight"
				| "cap"
				| "stale"
				| "repetition"
				| "length-exhausted"
				| "no-progress"
				| "context-overflow";
	  };

export function didAgentEndCleanly(messages: readonly AgentMessage[]): boolean {
	const lastAssistantIndex = findLastAssistantMessageIndex(messages);
	if (lastAssistantIndex === undefined) return false;

	const lastAssistant = messages[lastAssistantIndex];
	if (lastAssistant?.role !== "assistant") return false;
	if (!isContinuableStopReason(lastAssistant.stopReason) && !isMalformedToolUseTurn(lastAssistant)) return false;

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

// The agent loop demotes a tool-call-less `toolUse` stop to `stop` before `agent_end`, so the
// original stop reason is gone by the time a goal sees the turn. Accept either shape: the raw
// message (extensions observing it pre-demotion) or the demotion diagnostic the loop leaves behind.
export function isMalformedToolUseTurn(message: AssistantAgentMessage): boolean {
	if (message.content.some((content) => content.type === "toolCall")) return false;
	if (message.stopReason === "toolUse") return true;
	return (
		message.stopReason === "stop" &&
		(message.diagnostics ?? []).some((diagnostic) => diagnostic.type === EMPTY_TOOL_USE_DEMOTION_DIAGNOSTIC)
	);
}

function isAbortedToolResult(message: ToolResultAgentMessage): boolean {
	if (!message.isError) return false;
	return message.content.some((content) => content.type === "text" && /\babort(?:ed)?\b/i.test(content.text));
}

export function evaluateGoalContinuation(input: GoalContinuationInput): GoalContinuationVerdict {
	// Re-sending an overflowed context fails identically on every path (#1422).
	if (input.goal?.status === "active" && input.lastTurnStuckOnContextOverflow) {
		return { kind: "deny", reason: "context-overflow" };
	}
	if (!isEligibleForGoalContinuation(input)) return { kind: "deny", reason: "not-eligible" };
	if (input.continuationPending) return { kind: "deny", reason: "single-flight" };
	if (hasRepeatedNormalizedOutputHash(input.recentNormalizedOutputHashes))
		return { kind: "deny", reason: "repetition" };
	if (isNoProgressBudgetExhausted(input)) return { kind: "deny", reason: "no-progress" };
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

/** True when the open/total todo counts in the signature changed; the narration hash is ignored. */
export function hasGoalTodoProgress(
	input: Pick<GoalContinuationInput, "lastContinuationSignature" | "currentSignature">,
): boolean {
	if (input.lastContinuationSignature === undefined || input.currentSignature === undefined) return false;
	return todoStateOfSignature(input.lastContinuationSignature) !== todoStateOfSignature(input.currentSignature);
}

function todoStateOfSignature(signature: string): string {
	return signature.slice(0, signature.lastIndexOf(":"));
}

/**
 * How many recent tool-effect fingerprints a new one must differ from to count as progress. Far above the guard's
 * 60, so rotating through a fixed set of calls earns at most one progress turn per distinct call.
 */
export const GOAL_TOOL_EFFECT_WINDOW = 256;

// Run-to-run noise in a result: ISO timestamps, clock times, durations, pids, long numbers and long hex ids.
// Small counters ("12/200 modules", "3 failed") stay visible, so a poll whose state really advances is progress.
const VOLATILE_RESULT_TOKEN =
	/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?|\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s|m|h)\b|\bpid[ =:]?\d+|\b\d{6,}\b|\b[0-9a-f]{8,}\b/gi;
// Any number or long hex id in a non-mutating call's arguments: a counter or timestamp argument is not a new action.
const VOLATILE_ARGUMENT_TOKEN = /\b[0-9a-f]{8,}\b|\d+/gi;
// Tools whose arguments are the change itself; masking their numbers would merge distinct edits.
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["edit", "write", "apply_patch", "todo"]);

function callArguments(name: string, args: unknown): string {
	const json = JSON.stringify(args);
	return MUTATING_TOOL_NAMES.has(name) ? json : json.replace(VOLATILE_ARGUMENT_TOKEN, "#");
}

/**
 * Fingerprint of what a turn's tools did: every call's name and arguments (numbers masked unless the tool mutates
 * files), and every result's error flag and text with run-to-run noise masked. Re-running the same call with the
 * same outcome yields the same fingerprint, so a tool loop is not progress. A turn whose tool results all failed
 * has no fingerprint: failing is never progress.
 */
export function toolEffectFingerprint(messages: readonly AgentMessage[]): string | undefined {
	const parts: string[] = [];
	let succeeded = false;
	for (const message of messages) {
		if (message?.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "toolCall")
					parts.push(`call:${content.name}:${callArguments(content.name, content.arguments)}`);
			}
		} else if (message?.role === "toolResult") {
			const text = message.content
				.map((content) => (content.type === "text" ? content.text : content.type))
				.join("\n");
			if (!message.isError) succeeded = true;
			parts.push(
				`result:${message.toolName}:${message.isError ? "error" : "ok"}:${text.replace(VOLATILE_RESULT_TOKEN, "#")}`,
			);
		}
	}
	return succeeded ? hashAssistantText(parts.join("\u0000")) : undefined;
}

export function continuationTurnUsedTools(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => {
		if (message?.role === "toolResult") return true;
		return message?.role === "assistant" && message.content.some((content) => content.type === "toolCall");
	});
}

function isEligibleForGoalContinuation(input: GoalContinuationInput): boolean {
	if (input.goal?.status !== "active" || input.hasPendingMessages) return false;
	if (input.path === "sessionStart" && input.goal.continuationStoppedAt !== undefined) return false;
	if (input.path === "systemRecovery" || input.path === "providerRecovery") return true;
	if (input.path === "immediate") {
		return (
			input.lastTurnWasMalformedToolUse ||
			(input.lastStopReason !== undefined && isContinuableStopReason(input.lastStopReason))
		);
	}
	return input.isIdle;
}

/** Monitor-delayed deliveries are exempt: armed-wake waiting is by-design and rate-limited by the cache-aware timer. */
function isNoProgressBudgetExhausted(input: GoalContinuationInput): boolean {
	if (input.path === "monitorDelayed") return false;
	return (input.goal?.noProgressContinuations ?? 0) >= GOAL_NO_PROGRESS_CONTINUATION_LIMIT;
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
