/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	dropFailedAssistantTurns,
	getCurrentSystemMessage,
	normalizeContext,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	TextContent,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { estimateContextTokens as estimateProviderContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { resolveEffectiveReserveTokens } from "../extensions/builtin/compaction/policy.ts";
import { convertToLlm, isContextExcludedCustomMessage } from "../messages.ts";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import type { CompactionSettings as BaseCompactionSettings } from "./compaction-settings.ts";
import { estimateCacheKey, isTransientMessage, serializeForEstimate } from "./estimate-cache-key.ts";

export type CompactionSettings = BaseCompactionSettings & {
	/** Optional "provider/model" override for the compaction summarization model. */
	model?: string;
};
export { DEFAULT_COMPACTION_SETTINGS } from "./compaction-settings.ts";

import {
	consumeStreamWithIdleTimeout,
	DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS,
	summarizationMaxDurationMs,
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

function getMessagesFromProjectedEntryForCompaction(entry: ProjectedSessionEntry): AgentMessage[] {
	if (entry.sourceEntry.type === "compaction") return [];
	// System messages are prompt state, not conversation; the compaction entry carries their replay.
	return entry.messages.filter(
		(message) =>
			message.role !== "system" &&
			(message.role !== "custom" || !isContextExcludedCustomMessage(message.customType)),
	);
}

/**
 * Build the active-context prefix up to the projected entry `endIndex`, placing the previous
 * compaction summary before its retained messages. Entries keep their projected (context-edited)
 * contribution; older compaction entries inside the retained raw range keep their summary.
 */
function collectSourceMessages(
	pathEntries: SessionEntry[],
	projectedEntries: ProjectedSessionEntry[],
	previousCompactionIndex: number,
	endIndex: number,
): AgentMessage[] {
	const projectedMessages = new Map(projectedEntries.map((entry) => [entry.sourceEntry, entry.messages]));
	const rawEnd =
		endIndex < projectedEntries.length
			? pathEntries.indexOf(projectedEntries[endIndex].sourceEntry)
			: pathEntries.length;
	const messages: AgentMessage[] = [];
	let rawStart = 0;
	let rawPreviousCompactionIndex = -1;
	if (previousCompactionIndex >= 0) {
		const previousCompaction = projectedEntries[previousCompactionIndex].sourceEntry as CompactionEntry;
		rawPreviousCompactionIndex = pathEntries.indexOf(previousCompaction);
		messages.push(...projectedEntries[previousCompactionIndex].messages);
		const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId);
		// A retain-none compaction names itself as its first kept entry, so only later entries follow it.
		rawStart =
			firstKeptIndex >= 0 && firstKeptIndex < rawPreviousCompactionIndex
				? firstKeptIndex
				: rawPreviousCompactionIndex + 1;
	}
	for (let i = rawStart; i < rawEnd; i++) {
		if (i === rawPreviousCompactionIndex) continue;
		const entry = pathEntries[i];
		messages.push(
			...(entry.type === "compaction" ? sessionEntryToContextMessages(entry) : (projectedMessages.get(entry) ?? [])),
		);
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

function getLastAssistantUsageInfo(
	messages: AgentMessage[],
	counted: ReadonlySet<AgentMessage>,
): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!counted.has(message)) continue;
		const usage = getAssistantUsage(message);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	// Count the same set the next provider request will carry: convertToLlm drops
	// failed (error/aborted) assistant turns and their orphaned tool results.
	// Indices stay relative to the INPUT array because callers read
	// `messages[lastUsageIndex]` on the array they passed in.
	const counted = new Set<AgentMessage>(dropFailedAssistantTurns(messages));
	const usageInfo = getLastAssistantUsageInfo(messages, counted);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			if (counted.has(message)) estimated += estimateTokens(message);
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
		if (counted.has(messages[i])) trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Estimate projected context without trusting usage captured before a later edit or compaction. */
export function estimateProjectedContextTokens(
	projection: SessionProjection,
	branchEntries: SessionEntry[],
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		let projectedMessageIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			if (estimate.lastUsageIndex < nextMessageIndex) {
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			projectedMessageIndex = nextMessageIndex;
		}

		const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
		let latestInvalidatingEntryIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type === "context_edit" || entry.type === "compaction") {
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
	}

	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	// Count what the next provider request carries: failed assistant turns are dropped (see estimateContextTokens).
	for (const message of dropFailedAssistantTurns(projection.messages)) {
		if (message.role !== "system") tokens += estimateTokens(message);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - resolveEffectiveReserveTokens(contextWindow, settings);
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
 *
 * Cached per message object (senpi#2525): a message whose JSON is unchanged returns the memoized
 * value instead of re-scanning every content block. Reuse is validated by the message's JSON text,
 * never by identity alone, so any in-place change (including the resident store's token/text swaps)
 * re-estimates.
 */
export function estimateTokens(message: AgentMessage): number {
	if (isTransientMessage(message)) return computeEstimateTokens(message);
	const serialized = serializeForEstimate(message);
	if (serialized === undefined) return computeEstimateTokens(message);
	const key = estimateCacheKey(serialized);
	const cached = tokenEstimateCache.get(message);
	if (cached !== undefined && cached.key === key) return cached.tokens;
	const tokens = computeEstimateTokens(message);
	tokenEstimateCache.set(message, { key, tokens });
	return tokens;
}

interface TokenEstimateCacheEntry {
	readonly key: string;
	readonly tokens: number;
}

const tokenEstimateCache = new WeakMap<AgentMessage, TokenEstimateCacheEntry>();

function computeEstimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "system": {
			const system = message as SystemMessage;
			chars = estimateTextAndImageContentChars(system.content);
			if (system.sections) {
				for (const section of Object.values(system.sections)) {
					if (section) chars += section.length;
				}
			}
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
			return Math.ceil(chars / 4);
		}
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
		case "configurationUpdate":
			return 0;
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
		case "configurationUpdate":
			return false;
	}
	return false;
}

/**
 * The messages of a cut-point walk that weigh in its keep budget. A failed turn is
 * never sent (`dropFailedAssistantTurns` removes error/aborted assistants and the
 * tool results only they declared), so it may not absorb the budget: a tiny budget
 * walked back from the newest entry must reach the turn being answered instead of
 * stopping on the rejected attempts that followed it. A truncated (`length`)
 * response is real content and keeps its weight.
 */
function keepBudgetWeighted(messages: readonly AgentMessage[]): Set<AgentMessage> {
	return new Set(dropFailedAssistantTurns(messages));
}

function keepBudgetTokens(messages: readonly AgentMessage[], weighted: ReadonlySet<AgentMessage>): number {
	return messages.reduce((sum, message) => (weighted.has(message) ? sum + estimateTokens(message) : sum), 0);
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
		case "configurationUpdate":
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
	const entryMessages = entries.map((entry, index) =>
		index >= startIndex && index < endIndex ? contextMessagesForCompactionEntry(entry) : [],
	);
	const weighted = keepBudgetWeighted(entryMessages.flat());

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const messageTokens = keepBudgetTokens(entryMessages[i] ?? [], weighted);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Prefer the closest valid cut point at or after this entry. If trailing
			// tool results exceed the budget by themselves, keep their preceding
			// assistant tool call instead of falling back to the first message.
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
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
	context: TranscriptContext,
	options: SimpleStreamOptions,
	streamFn?: SummarizationStreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	summarizationMaxDurationMsOverride?: number,
): Promise<AssistantMessage> {
	// Summary requests retain the fork's request-identity split: each request gets a
	// fresh identity while affinity follows the caller. Cache-friendly callers may
	// opt into short retention for an exact provider-context prefix.
	const isolatedOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: options.cacheRetention ?? "none",
		affinitySessionId: options.affinitySessionId ?? options.sessionId,
		sessionId: uuidv7(),
	};
	const callerSignal = options.signal;
	// The 120s floor was tuned for healthy summaries; a large session feeds the
	// summarizer hundreds of thousands of tokens, which legitimately takes longer
	// on slower providers (#1068). Scale the per-attempt budget with the estimated
	// input size so compaction cannot deadlock purely on its own wall clock.
	const maxDurationMs = summarizationMaxDurationMs(
		estimateProviderContextTokens(context).tokens,
		summarizationMaxDurationMsOverride,
	);
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
			// Settlement rides inside the watchdog: a provider whose iterator ends
			// without a terminal event used to park here with every timer cleared.
			return await consumeStreamWithIdleTimeout(responseStream, {
				idleTimeoutMs: DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS,
				maxDurationMs,
				abort: () => requestController.abort(),
				signal: callerSignal,
				settle: async () => await (await responseStream).result(),
			});
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
	summarizationMaxDurationMs?: number,
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
			summarizationMaxDurationMs,
		)
	).text;
}

/** Build a standalone summary request or append its instruction to an existing provider context. */
export function buildSummarizationContext(promptText: string, sourceContext?: Context): TranscriptContext {
	const instructionMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: promptText }],
		timestamp: Date.now(),
	};

	if (sourceContext) {
		// A source that is already a transcript has no prompt/tool shorthand left to fold, so its
		// messages stay a byte-identical provider prefix ahead of the appended instruction.
		return normalizeContext({
			...sourceContext,
			messages: [...sourceContext.messages, instructionMessage],
		});
	}

	return normalizeContext({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [instructionMessage],
	});
}

/**
 * Extra room for provider framing and tokenizer variance omitted by the heuristic context estimate.
 * This matches the 4096-token margin used when normal simple requests clamp maxTokens to their context window.
 */
const CACHE_FRIENDLY_CONTEXT_SAFETY_TOKENS = 4096;

/** Whether the source context leaves room for the requested summary output and provider safety margin. */
export function cacheFriendlyContextFits(model: Model<any>, context: TranscriptContext, maxTokens: number): boolean {
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
	summarizationMaxDurationMs?: number,
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
		summarizationMaxDurationMs,
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

function isProjectedTurnStart(entry: ProjectedSessionEntry): boolean {
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some(isTurnStartMessage);
}

function findProjectedTurnStartIndex(entries: ProjectedSessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isProjectedTurnStart(entries[i])) return i;
	}
	return -1;
}

/** Projected counterpart of findValidCutPoints(), used when a caller forces compaction progress. */
function findProjectedValidCutPoints(entries: ProjectedSessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
	}
	return cutPoints;
}

function findProjectedCutPoint(
	entries: ProjectedSessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
	}
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulatedTokens = 0;
	let exceededBudget = false;
	let cutIndex = cutPoints[0];
	const weighted = keepBudgetWeighted(entries.slice(startIndex, endIndex).flatMap((entry) => entry.messages));
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const messageTokens = keepBudgetTokens(entries[i].messages, weighted);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			exceededBudget = true;
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// A recovery attempt and its omission edits are context-invisible after the last
	// visible input. Advance only for a closed suffix containing an omitted assistant
	// attempt; arbitrary metadata must not move the cut past unsent input.
	const suffix = entries.slice(cutIndex + 1, endIndex);
	const isIntrinsicallyVisible = (entry: ProjectedSessionEntry): boolean =>
		entry.sourceEntry.type !== "context_edit" && sessionEntryToContextMessages(entry.sourceEntry).length > 0;
	const isOmitted = (entry: ProjectedSessionEntry): boolean =>
		isIntrinsicallyVisible(entry) && entry.messages.length === 0;
	const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
	const hasExternalReplacement = suffix.some(
		(entry) =>
			entry.sourceEntry.type === "context_edit" &&
			entry.sourceEntry.replacement !== null &&
			!omittedSuffixIds.has(entry.sourceEntry.targetId),
	);
	const isRecoveryOmissionSuffix =
		exceededBudget &&
		!hasExternalReplacement &&
		suffix.some(
			(entry) =>
				entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant" && isOmitted(entry),
		) &&
		suffix.every(
			(entry) => entry.sourceEntry.type !== "compaction" && (!isIntrinsicallyVisible(entry) || isOmitted(entry)),
		);
	if (isRecoveryOmissionSuffix) cutIndex++;

	while (cutIndex > startIndex) {
		const previous = entries[cutIndex - 1];
		if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
		cutIndex--;
	}
	const startsTurn = isProjectedTurnStart(entries[cutIndex]);
	const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
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

	const projection = buildSessionProjection(pathEntries);
	const projectedEntries = projection.entries;
	const sourceEntries = projectedEntries.map((entry) => entry.sourceEntry);
	// The newest compaction is projected first. Older compaction entries can still
	// occur in its retained raw range, but their projected contribution is empty.
	const prevCompactionIndex = projectedEntries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		previousSummary = (projectedEntries[prevCompactionIndex].sourceEntry as CompactionEntry).summary;
		// The canonical projection has already selected the previous compaction's retained tail.
		boundaryStart = prevCompactionIndex + 1;
	}
	const boundaryEnd = projectedEntries.length;
	const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;
	let cutPoint = findProjectedCutPoint(projectedEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	if (forceProgress && cutPoint.firstKeptEntryIndex === boundaryStart) {
		const nextCutPoint = findProjectedValidCutPoints(projectedEntries, boundaryStart + 1, boundaryEnd)[0];
		if (nextCutPoint !== undefined) {
			const turnStartIndex = findProjectedTurnStartIndex(projectedEntries, nextCutPoint, boundaryStart);
			cutPoint = {
				firstKeptEntryIndex: nextCutPoint,
				turnStartIndex,
				isSplitTurn: turnStartIndex !== -1,
			};
		}
	}

	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKeptEntry?.id) return undefined;
	const firstKeptEntryId = firstKeptEntry.id;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const messagesToSummarize = projectedEntries
		.slice(boundaryStart, historyEnd)
		.flatMap(getMessagesFromProjectedEntryForCompaction);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? projectedEntries
				.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
				.flatMap(getMessagesFromProjectedEntryForCompaction)
		: [];

	const sourceMessages = collectSourceMessages(pathEntries, projectedEntries, prevCompactionIndex, historyEnd);
	const turnPrefixSourceMessages = cutPoint.isSplitTurn
		? collectSourceMessages(pathEntries, projectedEntries, prevCompactionIndex, cutPoint.firstKeptEntryIndex)
		: [];

	// A model switch can make an existing summary too large even when no new
	// messages were added. The retry fallback path explicitly opts into
	// regenerating that summary for its selected model's smaller context window.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0 && (!previousSummary || !allowSummaryOnly)) {
		return undefined;
	}

	// Extract file operations from edited model-visible messages and the previous compaction.
	const fileOps = extractFileOperations(messagesToSummarize, sourceEntries, prevCompactionIndex);

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
