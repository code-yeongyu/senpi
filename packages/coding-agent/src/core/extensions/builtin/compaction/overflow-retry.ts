import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../../../compaction/index.ts";

/**
 * Overflow-retry policy for summarization requests (issue #650).
 *
 * When the provider verdicts a completed summarization response as context
 * overflow, retrying with a slightly smaller input is correct — but the
 * historical loop removed exactly one history item per FULL billed attempt,
 * so a session whose summarization input exceeded the real window wedged on
 * "Compacting..." for the length of its history (observed: ~48 minutes and
 * ~13.5M billed tokens on gpt-5.6-sol). Every knob below exists to keep the
 * worst case small and observable:
 *
 * - the summarization input is pre-sized before the first attempt;
 * - each retry halves the estimated input instead of dropping one item;
 * - retries stop at a hard attempt cap and a cumulative wall-clock budget;
 * - exhaustion throws a typed error the deterministic fallback can classify.
 */

export const MAX_SUMMARIZATION_OVERFLOW_RETRIES = 3;

/**
 * Cumulative wall-clock budget across all overflow retries of one compaction
 * run. Twice the per-attempt stream budget: a slow provider may consume the
 * per-attempt watchdog on each attempt, and the retry loop must still end
 * well inside one user's patience.
 */
export const SUMMARIZATION_OVERFLOW_TOTAL_BUDGET_MS = 240_000;

/** Fraction of the context window the summarization input may occupy. */
export const SUMMARIZATION_INPUT_BUDGET_RATIO = 0.6;

/** Floor for the history budget after reserving space for the prompt. */
const MIN_HISTORY_BUDGET_TOKENS = 256;

export class SummarizationOverflowExhaustedError extends Error {
	readonly attempts: number;
	readonly elapsedMs: number;

	constructor(attempts: number, elapsedMs: number) {
		super(
			`Compaction summary request exceeded the context window after ${attempts} overflow ` +
				`${attempts === 1 ? "retry" : "retries"} over ${Math.round(elapsedMs / 1000)}s`,
		);
		this.name = "SummarizationOverflowExhaustedError";
		this.attempts = attempts;
		this.elapsedMs = elapsedMs;
	}
}

export interface PruneStep {
	messages: AgentMessage[];
	removedTokens: number;
}

export function estimateTotalTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const message of messages) total += estimateTokens(message);
	return total;
}

function getToolCallIds(message: AgentMessage): Set<string> {
	const ids = new Set<string>();
	if (message.role !== "assistant") return ids;
	for (const block of message.content) {
		if (block.type === "toolCall") ids.add(block.id);
	}
	return ids;
}

function findLastUserLikeIndex(messages: AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const role = messages[index]?.role;
		if (role === "user" || role === "bashExecution") return index;
	}
	return messages.length;
}

function removeAssistantToolPair(messages: AgentMessage[], assistantIndex: number): PruneStep {
	const ids = getToolCallIds(messages[assistantIndex]);
	let removedTokens = 0;
	const pruned = messages.filter((message, index) => {
		const remove = index === assistantIndex || (message.role === "toolResult" && ids.has(message.toolCallId));
		if (remove) removedTokens += estimateTokens(message);
		return !remove;
	});
	return { messages: pruned, removedTokens };
}

function removeFirstOldToolPair(messages: AgentMessage[], boundaryIndex: number): PruneStep | undefined {
	for (let index = 0; index < boundaryIndex; index++) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "assistant" && getToolCallIds(message).size > 0)
			return removeAssistantToolPair(messages, index);
		if (message.role === "toolResult") {
			return {
				messages: messages.filter((_message, candidateIndex) => candidateIndex !== index),
				removedTokens: estimateTokens(message),
			};
		}
	}
	return undefined;
}

function removeFirstOldMessage(messages: AgentMessage[], boundaryIndex: number): PruneStep | undefined {
	for (let index = 0; index < boundaryIndex; index++) {
		const message = messages[index];
		if (!message || message.role === "toolResult") continue;
		if (message.role === "assistant" && getToolCallIds(message).size > 0)
			return removeAssistantToolPair(messages, index);
		return {
			messages: messages.filter((_candidate, candidateIndex) => candidateIndex !== index),
			removedTokens: estimateTokens(message),
		};
	}
	return undefined;
}

export function pruneOldMessagesToBudget(messages: AgentMessage[], targetTokens: number): AgentMessage[] {
	let pruned = messages;
	let total = estimateTotalTokens(pruned);
	while (total > targetTokens) {
		const boundaryIndex = findLastUserLikeIndex(pruned);
		const next = removeFirstOldToolPair(pruned, boundaryIndex) ?? removeFirstOldMessage(pruned, boundaryIndex);
		if (!next || next.messages.length === pruned.length) break;
		pruned = next.messages;
		total -= next.removedTokens;
	}
	return pruned;
}

/** Estimated-token budget for the history portion of a summarization request. */
export function summarizationHistoryBudget(contextWindow: number, promptTokens: number): number {
	return Math.max(
		MIN_HISTORY_BUDGET_TOKENS,
		Math.floor(contextWindow * SUMMARIZATION_INPUT_BUDGET_RATIO) - promptTokens,
	);
}

/**
 * Pre-size the summarization input before the first billed attempt. Only the
 * oldest messages are dropped; a fitting input passes through untouched.
 */
export function boundSummarizationInput(
	messages: AgentMessage[],
	contextWindow: number,
	promptTokens: number,
): AgentMessage[] {
	return pruneOldMessagesToBudget(messages, summarizationHistoryBudget(contextWindow, promptTokens));
}

/**
 * Shrink for the next overflow retry. Halving the estimated input converges
 * in O(log n) retries instead of the historical one-item-per-attempt O(n),
 * where each attempt was a full billed summarization stream.
 */
export function shrinkSummarizationInputForOverflowRetry(
	messages: AgentMessage[],
	contextWindow: number,
	promptTokens: number,
): AgentMessage[] | undefined {
	if (messages.length <= 1) return undefined;
	const budget = summarizationHistoryBudget(contextWindow, promptTokens);
	const halfTokens = Math.floor(estimateTotalTokens(messages) / 2);
	const shrunk = pruneOldMessagesToBudget(messages, Math.min(halfTokens, budget));
	if (shrunk.length < messages.length) return shrunk;
	// Every remaining message sits at or after the turn boundary, so budget
	// pruning cannot shrink further; still drop the oldest so the retry
	// differs from the rejected attempt instead of re-billing an identical one.
	return messages.slice(1);
}

/**
 * Decide whether another billed overflow retry is allowed. The attempt cap and
 * the cumulative budget are both checked BEFORE scheduling a new request: an
 * attempt that consumed the whole per-attempt watchdog must not be followed by
 * another equally expensive one once the total budget is spent.
 */
export function allowOverflowRetry(attempts: number, elapsedMs: number): boolean {
	return attempts < MAX_SUMMARIZATION_OVERFLOW_RETRIES && elapsedMs < SUMMARIZATION_OVERFLOW_TOTAL_BUDGET_MS;
}
