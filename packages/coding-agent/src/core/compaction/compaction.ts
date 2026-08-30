/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type RetryCallbacks, type RetryPolicy, retryAssistantCall, uuidv7 } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { estimateContextTokens as estimateProviderContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { convertToLlm, filterContextExcludedMessages, isContextExcludedCustomMessage } from "../messages.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import type { CompactionSettings } from "./compaction-settings.ts";

export { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "./compaction-settings.ts";

import {
	consumeStreamWithIdleTimeout,
	DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS,
	DEFAULT_SUMMARIZATION_MAX_DURATION_MS,
} from "./stream-watchdog.ts";
import {
	contentTextForSummary,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

export type SummarizationStreamFn = StreamFn;
type SummarizationOptions = SimpleStreamOptions & {
	readonly env?: Record<string, string>;
};

function getAnthropicSummarizationFallback(model: Model<any>): readonly { model: string }[] | undefined {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") {
		return undefined;
	}
	const allowedFallbackModels = (model as Model<"anthropic-messages">).compat?.allowedFallbackModels;
	return allowedFallbackModels?.length
		? [
				{
					model:
						typeof allowedFallbackModels[0] === "string"
							? allowedFallbackModels[0]
							: allowedFallbackModels[0].model,
				},
			]
		: undefined;
}

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function contextMessagesForCompactionEntry(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "compaction") {
		return [];
	}
	return sessionEntryToContextMessages(entry).filter(
		(message) => message.role !== "custom" || !isContextExcludedCustomMessage(message.customType),
	);
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	return contextMessagesForCompactionEntry(entry)[0];
}

/** Build an active-context prefix, placing the previous compaction summary before its retained messages. */
function collectSourceMessages(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	previousCompactionIndex: number,
): AgentMessage[] {
	const messages: AgentMessage[] = [];
	if (previousCompactionIndex >= 0) {
		messages.push(...sessionEntryToContextMessages(entries[previousCompactionIndex]));
	}
	for (let i = startIndex; i < endIndex; i++) {
		// The latest compaction was moved to the front above. Keep older compaction
		// entries because buildSessionContext retains them in the active provider prefix.
		if (i !== previousCompactionIndex) {
			messages.push(...sessionEntryToContextMessages(entries[i]));
		}
	}
	return messages;
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

// ============================================================================
// Types
// ============================================================================

/** Active provider contexts and request settings used to preserve cacheable compaction prefixes. */
export interface CacheFriendlySummaryOptions {
	/** Exact provider context prefix containing the history to summarize. */
	sourceContext?: Context;
	/** Exact provider context prefix containing a split turn's prefix. */
	turnPrefixSourceContext?: Context;
	/** Provider request settings copied from the active agent request path. */
	requestOptions?: Pick<
		SimpleStreamOptions,
		"sessionId" | "onPayload" | "onResponse" | "transport" | "thinkingBudgets" | "maxRetryDelayMs"
	>;
}

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Threshold numerator. Prefer the larger of billed usage and the local
 * transcript estimate, unless billed usage is implausibly larger than the
 * estimate (Cursor cacheRead spikes of several million vs ~150k local).
 */
export function resolveThresholdContextTokens(usageTokens: number, estimateTokens: number): number {
	const usage = usageTokens > 0 ? usageTokens : 0;
	const estimate = estimateTokens > 0 ? estimateTokens : 0;
	if (estimate >= 50_000 && usage > estimate * 8) {
		return estimate;
	}
	return Math.max(usage, estimate);
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last valid assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * Long unbroken base64-ish runs (base64 payloads, data URLs, hex dumps) tokenize
 * near 1 token per character, not the ~4 chars/token of prose. Weight such runs
 * 4x so the shared chars/4 heuristic stays conservative for them; otherwise a
 * 1 MB inline screenshot estimates at ~256K tokens while providers count ~1M.
 */
const BASE64_RUN_RE = /[A-Za-z0-9+/=_-]{512,}/g;
const BASE64_CHAR_WEIGHT = 4;

function weightedChars(text: string): number {
	let chars = text.length;
	BASE64_RUN_RE.lastIndex = 0;
	for (const match of text.matchAll(BASE64_RUN_RE)) {
		chars += match[0].length * (BASE64_CHAR_WEIGHT - 1);
	}
	return chars;
}

function estimateTextAndImageContentChars(content: string | readonly (TextContent | ImageContent)[]): number {
	if (typeof content === "string") {
		return weightedChars(content);
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += weightedChars(block.text);
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + weightedChars(JSON.stringify(block.arguments));
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + weightedChars(message.output);
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}
}

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return contextMessagesForCompactionEntry(entry).some(isTurnStartMessage);
}

/**
 * Find valid cut points: indices of context-visible user-like or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			continue;
		}
		if (contextMessagesForCompactionEntry(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return {
			firstKeptEntryIndex: startIndex,
			turnStartIndex: -1,
			isSplitTurn: false,
		};
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const messageTokens = contextMessagesForCompactionEntry(entry).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			let foundCutPoint = false;
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					foundCutPoint = true;
					break;
				}
			}
			if (!foundCutPoint) {
				cutIndex = cutPoints[cutPoints.length - 1];
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at compaction boundaries or context-visible entries.
		if (prevEntry.type === "compaction" || contextMessagesForCompactionEntry(prevEntry).length > 0) {
			break;
		}
		if (prevEntry.type === "custom_message" && isContextExcludedCustomMessage(prevEntry.customType)) {
			break;
		}
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	if (response.stopReason === "length")
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	return undefined;
}

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

const SOURCE_CONTEXT_UPDATE_SUMMARIZATION_PROMPT = `The messages above contain an existing structured summary of earlier conversation history followed by NEW conversation messages.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

export function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	extraBody?: Record<string, unknown>,
	sessionId?: string,
	requestOptions?: CacheFriendlySummaryOptions["requestOptions"],
	cacheRetention?: SimpleStreamOptions["cacheRetention"],
): SummarizationOptions {
	const options: SummarizationOptions = {
		...requestOptions,
		maxTokens,
		signal,
		apiKey,
		headers,
		env,
		extraBody,
		cacheRetention,
	};
	if (sessionId) options.affinitySessionId = sessionId;
	const refusalFallbacks = getAnthropicSummarizationFallback(model);
	if (refusalFallbacks) options.refusalFallbacks = refusalFallbacks;
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */
export async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: SummarizationStreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// Summary requests retain the fork's request-identity split: each request gets a
	// fresh identity while affinity follows the caller. Cache-friendly callers may
	// opt into short retention for an exact provider-context prefix.
	const isolatedOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: options.cacheRetention ?? "none",
		affinitySessionId: options.affinitySessionId ?? options.sessionId,
		sessionId: uuidv7(),
		toolChoice: "none",
	};
	const callerSignal = options.signal;
	const produce = async (): Promise<AssistantMessage> => {
		// Request-local controller: the idle watchdog must be able to tear down a
		// stalled summarization request without aborting the caller's own signal.
		const requestController = new AbortController();
		const onCallerAbort = () => requestController.abort(callerSignal?.reason);
		if (callerSignal) {
			if (callerSignal.aborted) onCallerAbort();
			else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
		}
		try {
			const requestOptions = {
				...isolatedOptions,
				signal: requestController.signal,
			};
			const responseStream = Promise.resolve(
				streamFn ? streamFn(model, context, requestOptions) : streamSimple(model, context, requestOptions),
			);
			await consumeStreamWithIdleTimeout(responseStream, {
				idleTimeoutMs: DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS,
				maxDurationMs: DEFAULT_SUMMARIZATION_MAX_DURATION_MS,
				abort: () => requestController.abort(),
				signal: callerSignal,
			});
			return await (await responseStream).result();
		} finally {
			if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
		}
	};
	return retryAssistantCall(produce, retry, callerSignal, callbacks);
}

async function transformSummarySource(
	currentMessages: AgentMessage[],
	previousSummary: string | undefined,
	transformContext: ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined,
	signal: AbortSignal | undefined,
): Promise<{
	readonly messages: AgentMessage[];
	readonly previousSummary: string | undefined;
}> {
	if (!transformContext) return { messages: currentMessages, previousSummary };
	if (!previousSummary) {
		return {
			messages: await transformContext(currentMessages, signal),
			previousSummary: undefined,
		};
	}

	const timestamps = new Set(currentMessages.map((message) => message.timestamp));
	let summaryTimestamp = -1;
	while (timestamps.has(summaryTimestamp)) {
		summaryTimestamp--;
	}
	const transformed = await transformContext(
		[
			{
				role: "user",
				content: [{ type: "text", text: previousSummary }],
				timestamp: summaryTimestamp,
			},
			...currentMessages,
		],
		signal,
	);
	const transformedSummary = transformed.filter((message) => message.timestamp === summaryTimestamp);
	return {
		messages: transformed.filter((message) => message.timestamp !== summaryTimestamp),
		previousSummary:
			transformedSummary.length > 0 ? serializeConversation(convertToLlm(transformedSummary)) : undefined,
	};
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	extraBody?: Record<string, unknown>,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	cacheFriendly?: Pick<CacheFriendlySummaryOptions, "sourceContext" | "requestOptions">,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			extraBody,
			thinkingLevel,
			streamFn,
			env,
			transformContext,
			retry,
			callbacks,
			sessionId,
			cacheFriendly,
		)
	).text;
}

/** Build a standalone summary request or append its instruction to an existing provider context. */
export function buildSummarizationContext(promptText: string, sourceContext?: Context): Context {
	const instructionMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: promptText }],
		timestamp: Date.now(),
	};

	if (sourceContext) {
		return {
			...sourceContext,
			messages: [...sourceContext.messages, instructionMessage],
		};
	}

	return {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [instructionMessage],
	};
}

/**
 * Extra room for provider framing and tokenizer variance omitted by the heuristic context estimate.
 * This matches the 4096-token margin used when normal simple requests clamp maxTokens to their context window.
 */
const CACHE_FRIENDLY_CONTEXT_SAFETY_TOKENS = 4096;

/** Whether the source context leaves room for the requested summary output and provider safety margin. */
export function cacheFriendlyContextFits(model: Model<any>, context: Context, maxTokens: number): boolean {
	return (
		model.contextWindow <= 0 ||
		estimateProviderContextTokens(context).tokens + maxTokens + CACHE_FRIENDLY_CONTEXT_SAFETY_TOKENS <=
			model.contextWindow
	);
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	extraBody?: Record<string, unknown>,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	cacheFriendly?: Pick<CacheFriendlySummaryOptions, "sourceContext" | "requestOptions">,
): Promise<{ text: string; usage: Usage }> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	let sourceContext = cacheFriendly?.sourceContext;
	let transformedSource = { messages: currentMessages, previousSummary };
	if (!sourceContext) {
		transformedSource = await transformSummarySource(currentMessages, previousSummary, transformContext, signal);
	}
	const providerPreviousSummary = transformedSource.previousSummary;
	let basePrompt = providerPreviousSummary
		? sourceContext
			? SOURCE_CONTEXT_UPDATE_SUMMARIZATION_PROMPT
			: UPDATE_SUMMARIZATION_PROMPT
		: SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	if (
		sourceContext &&
		!cacheFriendlyContextFits(model, buildSummarizationContext(basePrompt, sourceContext), maxTokens)
	) {
		sourceContext = undefined;
		transformedSource = await transformSummarySource(currentMessages, previousSummary, transformContext, signal);
		basePrompt = transformedSource.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
		if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	let promptText = "";
	if (!sourceContext) {
		const llmMessages = convertToLlm(transformedSource.messages);
		const conversationText = serializeConversation(llmMessages);
		promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (transformedSource.previousSummary) {
			promptText += `<previous-summary>\n${transformedSource.previousSummary}\n</previous-summary>\n\n`;
		}
	}
	promptText += basePrompt;

	const completionOptions = createSummarizationOptions(
		model,
		maxTokens,
		apiKey,
		headers,
		env,
		signal,
		thinkingLevel,
		extraBody,
		sessionId,
		sourceContext ? cacheFriendly?.requestOptions : undefined,
		sourceContext ? "short" : undefined,
	);
	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText, sourceContext),
		completionOptions,
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Summarization");
	if (failure) throw new Error(failure);
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summarization attempted to call a tool");
	}

	const textContent = contentTextForSummary(response.content);

	return { text: textContent, usage: response.usage };
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/**
	 * Active-context prefix for the history summary.
	 * Includes the previous compaction summary before messages retained by that compaction.
	 */
	sourceMessages?: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Active-context prefix through the split-turn prefix, or empty when not splitting. */
	turnPrefixSourceMessages?: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	forceProgress = false,
	allowSummaryOnly = false,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(
		filterContextExcludedMessages(buildSessionContext(pathEntries).messages),
	).tokens;

	let cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	if (forceProgress && cutPoint.firstKeptEntryIndex === boundaryStart) {
		const nextCutPoint = findValidCutPoints(pathEntries, boundaryStart + 1, boundaryEnd)[0];
		if (nextCutPoint !== undefined) {
			const turnStartIndex = findTurnStartIndex(pathEntries, nextCutPoint, boundaryStart);
			cutPoint = {
				firstKeptEntryIndex: nextCutPoint,
				turnStartIndex,
				isSplitTurn: turnStartIndex !== -1,
			};
		}
	}

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	const sourceMessages = collectSourceMessages(pathEntries, boundaryStart, historyEnd, prevCompactionIndex);

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const turnPrefixSourceMessages = cutPoint.isSplitTurn
		? collectSourceMessages(pathEntries, boundaryStart, cutPoint.firstKeptEntryIndex, prevCompactionIndex)
		: [];

	// A model switch can make an existing summary too large even when no new
	// messages were added. The retry fallback path explicitly opts into
	// regenerating that summary for its selected model's smaller context window.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0 && (!previousSummary || !allowSummaryOnly)) {
		return undefined;
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		sourceMessages,
		turnPrefixMessages,
		turnPrefixSourceMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

export { compact } from "./compaction-execution.ts";
