import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateCacheKey, isTransientMessage, serializeForEstimate } from "../../../compaction/estimate-cache-key.ts";
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
 * CJK text tokenizes far denser than the chars/4 prose heuristic (roughly one
 * token per 1.5 Korean characters, not four). The shared estimator undercounts
 * such text by ~2.7x, so a Korean-heavy session whose estimate "fits" could
 * still produce a summarization request over provider size limits (observed
 * 2026-08-16 as gateway HTTP 413 rejections on every fallback model). Weight
 * CJK runs so request sizing stays conservative for them, mirroring the
 * estimator's existing base64-run weighting.
 */
const CJK_RUN_RE = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{2FA1F}]+/gu;
const CJK_CHAR_WEIGHT = 3;

function cjkExtraChars(text: string): number {
	let extra = 0;
	for (const match of text.matchAll(CJK_RUN_RE)) {
		extra += match[0].length * (CJK_CHAR_WEIGHT - 1);
	}
	return extra;
}

/**
 * Request-sizing estimate: the shared chars/4 estimate plus a CJK density
 * correction. JSON serialization carries every content field, so CJK runs are
 * counted wherever they appear (text, tool arguments, outputs, summaries).
 *
 * Cached per message object with the same JSON-text key as `estimateTokens`
 * (senpi#2525): the emergency-prune path estimates the whole context every turn,
 * and an unchanged message must not pay for another CJK scan. The key is the
 * serialization the scan needs anyway, so a miss costs nothing extra.
 */
function estimateWireTokens(message: AgentMessage): number {
	const serialized = serializeForEstimate(message);
	if (serialized === undefined || isTransientMessage(message)) return computeWireTokens(message, serialized);
	const key = estimateCacheKey(serialized);
	const cached = wireEstimateCache.get(message);
	if (cached !== undefined && cached.key === key) return cached.tokens;
	const tokens = computeWireTokens(message, serialized);
	wireEstimateCache.set(message, { key, tokens });
	return tokens;
}

interface WireEstimateCacheEntry {
	readonly key: string;
	readonly tokens: number;
}

const wireEstimateCache = new WeakMap<AgentMessage, WireEstimateCacheEntry>();

function computeWireTokens(message: AgentMessage, serialized: string | undefined): number {
	const base = estimateTokens(message);
	if (serialized === undefined) return base;
	return base + Math.ceil(cjkExtraChars(serialized) / 4);
}

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
	for (const message of messages) total += estimateWireTokens(message);
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
		if (remove) removedTokens += estimateWireTokens(message);
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
				removedTokens: estimateWireTokens(message),
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
			removedTokens: estimateWireTokens(message),
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

function removeFirstToolPairAfter(messages: AgentMessage[], boundaryIndex: number): PruneStep | undefined {
	for (let index = boundaryIndex + 1; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role === "assistant" && getToolCallIds(message).size > 0)
			return removeAssistantToolPair(messages, index);
	}
	return undefined;
}

/** Shortest request text a truncation keeps, so the summary still sees what was asked. */
const TRUNCATED_REQUEST_MIN_CHARS = 200;

const TRUNCATION_NOTE = /\n\n\[\.\.\. (\d+) more characters truncated\]$/;

/**
 * When the turn's request alone is over the budget, keep it but cut its text to fit (images and other non-text
 * blocks go with the cut), so a giant pasted prompt still compacts instead of exhausting every retry (senpi#4079).
 * Returns undefined when the request is within the budget or too short to cut.
 */
function truncateRequestToBudget(messages: AgentMessage[], targetTokens: number): AgentMessage[] | undefined {
	const requestIndex = findLastUserLikeIndex(messages);
	const request = messages[requestIndex];
	if (request?.role !== "user") return undefined;
	const requestTokens = estimateWireTokens(request);
	if (requestTokens <= targetTokens) return undefined;
	const fullText =
		typeof request.content === "string"
			? request.content
			: request.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	// A request cut by an earlier retry carries its note; fold that count into the new one instead of nesting notes.
	const earlierCut = TRUNCATION_NOTE.exec(fullText);
	const text = earlierCut ? fullText.slice(0, earlierCut.index) : fullText;
	const alreadyCut = earlierCut ? Number(earlierCut[1]) : 0;
	if (text.length <= TRUNCATED_REQUEST_MIN_CHARS) return undefined;
	const available = Math.max(0, targetTokens - (estimateTotalTokens(messages) - requestTokens));
	// The cut ratio is measured on the text alone: images never reach the serialized summary input, so their
	// estimated weight must not deepen the cut.
	const textTokens = Math.max(1, estimateWireTokens({ ...request, content: text }));
	let keep = Math.min(
		text.length - 1,
		Math.max(TRUNCATED_REQUEST_MIN_CHARS, Math.floor((text.length * available) / textTokens)),
	);
	for (;;) {
		const truncated: AgentMessage = {
			...request,
			content: `${text.slice(0, keep)}\n\n[... ${text.length - keep + alreadyCut} more characters truncated]`,
		};
		if (estimateWireTokens(truncated) <= available || keep <= TRUNCATED_REQUEST_MIN_CHARS)
			return messages.map((message, index) => (index === requestIndex ? truncated : message));
		keep = Math.max(TRUNCATED_REQUEST_MIN_CHARS, Math.floor(keep * 0.8));
	}
}

/**
 * Summarization input only: drop the oldest history first, then, when the last turn alone is still over the budget,
 * its oldest tool steps. The turn's request is kept and a tool call never loses its result (senpi#4079). Live context
 * pruning keeps using `pruneOldMessagesToBudget`, which never touches the last turn.
 */
function pruneSummarizationInputToBudget(messages: AgentMessage[], targetTokens: number): AgentMessage[] {
	let pruned = pruneOldMessagesToBudget(messages, targetTokens);
	let total = estimateTotalTokens(pruned);
	while (total > targetTokens) {
		const next = removeFirstToolPairAfter(pruned, findLastUserLikeIndex(pruned));
		if (!next) break;
		pruned = next.messages;
		total -= next.removedTokens;
	}
	return pruned;
}

/**
 * Pre-size the summarization input before the first billed attempt: oldest
 * history first, then the last turn's oldest tool steps; when the turn's
 * request alone is still over the budget, its text is cut to fit. A fitting
 * input passes through untouched.
 */
export function boundSummarizationInput(
	messages: AgentMessage[],
	contextWindow: number,
	promptTokens: number,
): AgentMessage[] {
	const budget = summarizationHistoryBudget(contextWindow, promptTokens);
	const pruned = pruneSummarizationInputToBudget(messages, budget);
	// Without a user-like request (a turn that starts with a custom or summary
	// entry) pruning can remove everything; the newest message is kept so the
	// summary never runs on an empty conversation.
	if (pruned.length === 0) return messages.slice(-1);
	if (estimateTotalTokens(pruned) <= budget) return pruned;
	return truncateRequestToBudget(pruned, budget) ?? pruned;
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
	const budget = summarizationHistoryBudget(contextWindow, promptTokens);
	const halfTokens = Math.floor(estimateTotalTokens(messages) / 2);
	const target = Math.min(halfTokens, budget);
	// A lone message is never pruned away: an over-target request is cut instead, anything else gives up.
	if (messages.length <= 1) return truncateRequestToBudget(messages, target);
	const shrunk = pruneSummarizationInputToBudget(messages, target);
	if (shrunk.length < messages.length) return shrunk;
	// Nothing prunable is left: what remains after the request is plain replies
	// (or orphaned results and custom entries). Still drop one so the retry differs from the rejected
	// attempt instead of re-billing an identical one; the oldest one after the
	// request goes before the request itself (senpi#4079).
	const boundaryIndex = findLastUserLikeIndex(messages);
	if (boundaryIndex < messages.length - 1) return messages.filter((_message, index) => index !== boundaryIndex + 1);
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
