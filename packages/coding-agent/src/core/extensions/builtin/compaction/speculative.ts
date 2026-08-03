import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	hasCredentialHeaders,
	isContextOverflow,
	isRetryableAssistantError,
	type Message,
	type Model,
	type StreamOptions,
	sanitizeAnthropicToolPairs as sanitizeAnthropicPayload,
	type TextContent,
	type Tool,
} from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/compat";
import {
	type CompactionPreparation,
	type CompactionResult,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	prepareCompaction,
} from "../../../compaction/index.ts";
import {
	consumeStreamWithIdleTimeout,
	DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS,
	DEFAULT_SUMMARIZATION_MAX_DURATION_MS,
} from "../../../compaction/stream-watchdog.ts";
import { convertToLlm } from "../../../messages.ts";
import type { ModelRegistry } from "../../../model-registry.ts";
import type { ReadonlySessionManager } from "../../../session-manager.ts";
import type { ApplyCompactionResult, ContextUsage, ProviderRequestPreparation } from "../../types.ts";
import {
	allowOverflowRetry,
	boundSummarizationInput,
	estimateTotalTokens,
	pruneOldMessagesToBudget,
	SUMMARIZATION_INPUT_BUDGET_RATIO,
	SummarizationOverflowExhaustedError,
	shrinkSummarizationInputForOverflowRetry,
} from "./overflow-retry.ts";
import { computeEffectiveKeepRecentTokens, computeEffectiveThreshold } from "./policy.ts";
import { buildPrompt, type MergedCompactionPromptVariant } from "./prompts.ts";
import { repairOrphanedToolResults } from "./repair-tool-pairs.ts";
import { extractTaskIntent, resolveInheritedTaskIntent } from "./task-intent.ts";
import * as truncation from "./tool-truncation.ts";
import { computeStructuralYield } from "./yield.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const EMERGENCY_CONTEXT_TARGET_RATIO = 0.95;
// Hysteresis: the emergency prune engages at EMERGENCY_CONTEXT_TARGET_RATIO but only
// releases once the context falls below this lower ratio. A single threshold makes a
// session parked near the limit alternate between the pruned and un-pruned history on
// consecutive requests; because pruning rewrites old tool results, every alternation
// invalidates the provider prompt-cache prefix and re-bills the whole conversation.
const EMERGENCY_CONTEXT_RELEASE_RATIO = 0.85;
const SUMMARY_TOKEN_HEADROOM = 32_768;
const SUMMARY_CONTEXT_WINDOW_RESERVE_RATIO = 0.5;
const SUMMARY_SCHEMA = "senpi.compaction.summary.v1";
type CompactionProgressCallback = (delta: string) => void;

export interface SpeculativeCompactionContext {
	model: Model<any> | undefined;
	sessionManager: ReadonlySessionManager;
	modelRegistry?: ModelRegistry;
	getContextUsage(): ContextUsage | undefined;
	getCompactionSettings?(): CompactionPreparation["settings"];
	getMessageRevision(): number;
	getSystemPrompt?(): string;
	prepareProviderRequest?(messages: AgentMessage[]): Promise<ProviderRequestPreparation>;
	applyCompaction(
		precomputed: CompactionResult,
		options: { reason: "extension"; expectedRevision: number; signal?: AbortSignal },
	): Promise<ApplyCompactionResult>;
}

export interface SpeculativeCompactionSnapshot {
	generation: number;
	expectedRevision: number;
	model: Model<any>;
	contextWindow: number;
	preparation: CompactionPreparation;
	branchEntries?: ReturnType<ReadonlySessionManager["getBranch"]>;
	promptVariant: MergedCompactionPromptVariant;
	origin?: "speculative" | "blocking" | "core-route";
	customInstructions?: string;
	/** Agent system prompt; used to make the summarization request look like normal agent traffic. */
	systemPrompt?: string;
	/** Agent tool definitions; forwarded so the request shape matches normal agent traffic. */
	tools?: Tool[];
}

export type SpeculativeCompactionResult = ApplyCompactionResult | { applied: false; reason: "unavailable" | "failed" };

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Summary-generation failure with a user-facing diagnosis. Distinct from a
 * user abort (which resolves `undefined`): callers surface `message` on the
 * manual route and degrade to "unavailable" on automatic routes.
 */
/**
 * Provider `error` stop during summarization, carrying the metadata-aware
 * transient classification from the full assistant message. A refusal whose
 * text happens to look retryable must still surface loudly; the message
 * string alone cannot encode that.
 */
export type SummaryRequestFailureKind = "upstream-stream-truncated";

export class SummaryRequestError extends Error {
	readonly transient: boolean;
	readonly failureKind?: SummaryRequestFailureKind;

	constructor(message: string, transient: boolean, failureKind?: SummaryRequestFailureKind) {
		super(message);
		this.name = "SummaryRequestError";
		this.transient = transient;
		this.failureKind = failureKind;
	}
}

const UPSTREAM_STREAM_TRUNCATED_PATTERN = /(?:^|[^A-Za-z0-9_])upstream_stream_truncated(?:[^A-Za-z0-9_]|$)/;

function summaryRequestFailureKind(response: AssistantMessage): SummaryRequestFailureKind | undefined {
	if (response.stopDetails?.type === "refusal" || response.stopDetails?.type === "sensitive") return undefined;
	return UPSTREAM_STREAM_TRUNCATED_PATTERN.test(response.errorMessage ?? "") ? "upstream-stream-truncated" : undefined;
}

export class SummaryGenerationError extends Error {
	readonly kind: "auth" | "empty-summary";

	constructor(kind: "auth" | "empty-summary", message: string) {
		super(message);
		this.name = "SummaryGenerationError";
		this.kind = kind;
	}
}

/**
 * Output budget for one summarization request. Adaptive-thinking models emit
 * reasoning tokens before the summary text, so the legacy flat 8192 cap could
 * be consumed entirely by thinking, ending the stream with zero text blocks.
 * Grant generous headroom, clamped to what the model can actually emit and to
 * half the context window: providers that enforce input + output <= window
 * would otherwise reject the request for models advertising contextWindow ==
 * maxTokens (every summarization request also carries conversation input).
 */
function summaryMaxTokens(model: Model<any>, contextWindow: number): number {
	const headroom = model.maxTokens > 0 ? Math.min(SUMMARY_TOKEN_HEADROOM, model.maxTokens) : SUMMARY_TOKEN_HEADROOM;
	if (contextWindow > 0) {
		return Math.min(headroom, Math.floor(contextWindow * SUMMARY_CONTEXT_WINDOW_RESERVE_RATIO));
	}
	return headroom;
}

/**
 * Reasoning override for summarization requests. Compaction must be fast: a
 * summarization request that inherits the provider's default reasoning mode
 * burns its latency (and output budget) on invisible thinking before emitting
 * the summary. Disable or minimize reasoning per wire family; adapters ignore
 * options their provider does not support. Mirrors how OpenAI Codex keeps its
 * compaction turn cheap.
 */
function summarizationReasoningOptions(model: Model<any>): Record<string, unknown> {
	if (!model.reasoning) return {};
	if (model.api === "anthropic-messages") return { thinkingEnabled: false };
	const reasoningEffort = (["low", "medium", "high"] as const).find(
		(level) => model.thinkingLevelMap?.[level] !== null,
	);
	if (!reasoningEffort) return {};
	switch (model.api) {
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return { reasoningEffort, reasoningSummary: null };
		case "openai-completions":
			return { reasoningEffort };
		default:
			return {};
	}
}

function getSummaryText(message: Message): string {
	const content = Array.isArray(message.content)
		? message.content
		: [{ type: "text" as const, text: message.content }];
	return content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

function isAssistantMessage(message: Message): message is AssistantMessage {
	return message.role === "assistant" && "stopReason" in message;
}

/**
 * Providers registered through `pi.registerProvider()` (claude-sdk-oauth, Kiro, any
 * extension provider) exist only in Senpi's ModelRuntime, never in compat's builtin
 * api-registry, which rejects their api id outright. Dispatch through the runtime
 * whenever it is reachable and keep compat for contexts constructed without a registry.
 */
function summarizationStream(
	context: SpeculativeCompactionContext,
	model: Model<any>,
	requestContext: Context,
	options: StreamOptions & Record<string, unknown>,
): AssistantMessageEventStream {
	const runtime = context.modelRegistry?.modelRuntime;
	return runtime ? runtime.stream(model, requestContext, options) : stream(model, requestContext, options);
}

async function generateSummaryMessage(options: {
	context: SpeculativeCompactionContext;
	messages: AgentMessage[];
	onProgress?: CompactionProgressCallback;
	prompt: ReturnType<typeof buildPrompt>;
	signal?: AbortSignal;
	snapshot: SpeculativeCompactionSnapshot;
	auth: {
		apiKey?: string;
		headers?: Record<string, string>;
		extraBody?: Record<string, unknown>;
	};
}): Promise<Message | undefined> {
	// Send the conversation as native LLM messages with the summarization
	// instruction as a trailing user message, mirroring normal agent traffic.
	// A single serialized `<conversation>` text dump of a large session is
	// deterministically refused by Anthropic's anti-distillation classifier
	// ("reverse engineering or duplicating model outputs"), while the same
	// content as native blocks with the agent's system prompt and tools passes.
	// Request-local controller: the idle watchdog must be able to tear down a
	// stalled summarization request without aborting the caller's own signal.
	const requestController = new AbortController();
	const onCallerAbort = () => requestController.abort(options.signal?.reason);
	if (options.signal) {
		if (options.signal.aborted) onCallerAbort();
		else options.signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	try {
		const requestMessages: AgentMessage[] = [
			...options.messages,
			{
				role: "user",
				content: [{ type: "text", text: options.prompt.user }],
				timestamp: Date.now(),
			},
		];
		const providerRequest = await options.context.prepareProviderRequest?.(requestMessages);
		const requestContext = {
			systemPrompt: options.snapshot.systemPrompt ?? options.prompt.system,
			messages: repairOrphanedToolResults(convertToLlm(providerRequest?.messages ?? requestMessages)),
			...(options.snapshot.tools && options.snapshot.tools.length > 0 ? { tools: options.snapshot.tools } : {}),
		};
		const headers = providerRequest
			? await providerRequest.transformHeaders(options.auth.headers ?? {})
			: options.auth.headers;
		const responseStream = summarizationStream(options.context, options.snapshot.model, requestContext, {
			apiKey: options.auth.apiKey,
			headers,
			extraBody: options.auth.extraBody,
			onPayload: async (payload, model) => {
				const sanitized = model.api === "anthropic-messages" ? sanitizeAnthropicPayload(payload) : payload;
				return providerRequest ? await providerRequest.transformPayload(sanitized) : sanitized;
			},
			maxTokens: summaryMaxTokens(options.snapshot.model, options.snapshot.contextWindow),
			signal: requestController.signal,
			...summarizationReasoningOptions(options.snapshot.model),
		});
		await consumeStreamWithIdleTimeout(responseStream, {
			idleTimeoutMs: DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS,
			maxDurationMs: DEFAULT_SUMMARIZATION_MAX_DURATION_MS,
			abort: () => requestController.abort(),
			signal: options.signal,
			onEvent: (event) => {
				if (event.type === "text_delta" && event.delta) {
					options.onProgress?.(event.delta);
				}
			},
		});
		return await responseStream.result();
	} finally {
		if (options.signal) options.signal.removeEventListener("abort", onCallerAbort);
	}
}

function pruneToolResults(messages: AgentMessage[], contextWindow: number, budgetRatio: number): AgentMessage[] {
	const toolResults = messages
		.filter((message) => message.role === "toolResult")
		.map((message) => ({ content: message.content, details: undefined }));
	if (toolResults.length === 0) return messages;

	const prunedResults = truncation.prePruneToolOutputsToBudget(toolResults, contextWindow * budgetRatio);
	let resultIndex = 0;
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const pruned = prunedResults[resultIndex];
		resultIndex++;
		return pruned ? { ...message, content: pruned.content } : message;
	});
}

export function truncateContextMessages(messages: AgentMessage[]): AgentMessage[] {
	const toolResults = messages
		.filter((message) => message.role === "toolResult")
		.map((message) => ({ content: message.content, details: undefined }));
	if (toolResults.length === 0) return messages;

	const truncatedResults = truncation.truncateOversizedToolResults(toolResults);
	let resultIndex = 0;
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const truncated = truncatedResults[resultIndex];
		resultIndex++;
		return truncated ? { ...message, content: truncated.content } : message;
	});
}

/**
 * Sticky engage/release state for {@link hardLimitEmergencyPrune}. Callers that
 * issue many requests for one session share a single latch so the emitted context
 * shape stays stable while the estimate hovers around the engage threshold.
 */
export interface EmergencyPruneLatch {
	engaged: boolean;
}

export function createEmergencyPruneLatch(): EmergencyPruneLatch {
	return { engaged: false };
}

export function hardLimitEmergencyPrune(
	messages: AgentMessage[],
	contextWindow: number,
	latch?: EmergencyPruneLatch,
): {
	messages: AgentMessage[];
	needsAggressiveCompaction: boolean;
} {
	const targetTokens = Math.floor(contextWindow * EMERGENCY_CONTEXT_TARGET_RATIO);
	const releaseTokens = Math.floor(contextWindow * EMERGENCY_CONTEXT_RELEASE_RATIO);
	const totalTokens = estimateTotalTokens(messages);
	// Without a latch this keeps the historical single-threshold behaviour.
	const engaged = latch
		? latch.engaged
			? totalTokens > releaseTokens
			: totalTokens > targetTokens
		: totalTokens > targetTokens;
	if (latch) latch.engaged = engaged;
	if (!engaged) {
		return { messages, needsAggressiveCompaction: false };
	}
	const noLlmPruned = truncateContextMessages(
		pruneToolResults(messages, contextWindow, SUMMARIZATION_INPUT_BUDGET_RATIO),
	);
	if (estimateTotalTokens(noLlmPruned) <= targetTokens) {
		return { messages: noLlmPruned, needsAggressiveCompaction: false };
	}
	return {
		messages: pruneOldMessagesToBudget(noLlmPruned, targetTokens),
		needsAggressiveCompaction: true,
	};
}

export function getPromptVariant(options: {
	reason: string;
	preparation: { previousSummary?: string; isSplitTurn: boolean };
}): MergedCompactionPromptVariant {
	if (options.reason === "branch") return "branch";
	if (options.preparation.previousSummary) return "update";
	if (options.preparation.isSplitTurn) return "turn_prefix";
	return "default";
}

export function createSpeculativeCompactionSnapshot(
	context: SpeculativeCompactionContext,
	options: {
		customInstructions?: string;
		generation: number;
		origin?: "speculative" | "blocking" | "core-route";
		tools?: Tool[];
	},
): SpeculativeCompactionSnapshot | undefined {
	const model = context.model;
	if (!model) return undefined;

	const expectedRevision = context.getMessageRevision();
	const branchEntries = context.sessionManager.getBranch();
	const contextWindow = context.getContextUsage()?.contextWindow ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const settings = context.getCompactionSettings?.() ?? DEFAULT_COMPACTION_SETTINGS;
	const thresholdRatio = computeEffectiveThreshold(contextWindow);
	const preparation = prepareCompaction(branchEntries, {
		...settings,
		keepRecentTokens: computeEffectiveKeepRecentTokens(settings.keepRecentTokens, contextWindow, thresholdRatio),
	});
	if (!preparation) return undefined;

	return {
		generation: options.generation,
		expectedRevision,
		model,
		contextWindow,
		preparation,
		branchEntries,
		promptVariant: getPromptVariant({ reason: "extension", preparation }),
		...(options.origin ? { origin: options.origin } : {}),
		customInstructions: options.customInstructions,
		systemPrompt: context.getSystemPrompt?.(),
		tools: options.tools,
	};
}

/**
 * Generate a compaction summary for the snapshot. Resolves `undefined` only
 * when the request was aborted (caller signal or an aborted stream); every
 * other failure throws — {@link SummaryGenerationError} for diagnosable
 * generation failures, the raw provider error otherwise. Abort is checked
 * before and after credential resolution so a cancelled request never
 * misreports as an auth failure.
 */
export async function runExtensionCompaction(
	context: SpeculativeCompactionContext,
	snapshot: SpeculativeCompactionSnapshot,
	signal?: AbortSignal,
	onProgress?: CompactionProgressCallback,
): Promise<CompactionResult | undefined> {
	if (signal?.aborted) return undefined;
	const auth = await context.modelRegistry?.getApiKeyAndHeaders(snapshot.model);
	if (signal?.aborted) return undefined;
	// A provider is authenticated for summarization by either a resolved key or a
	// credential request header: `headers`-authenticated providers (models.json and
	// extension providers alike) never resolve an apiKey, yet their normal agent
	// turns are fully authenticated.
	if (!auth?.ok || !(auth.apiKey || hasCredentialHeaders(auth.headers))) {
		const detail =
			auth && !auth.ok ? auth.error : `no credentials resolved for provider "${snapshot.model.provider}"`;
		throw new SummaryGenerationError("auth", `summarization credentials unavailable: ${detail}`);
	}

	const prompt = buildPrompt({
		variant: snapshot.promptVariant,
		previousSummary: snapshot.preparation.previousSummary,
		taskIntent: resolveInheritedTaskIntent(snapshot.branchEntries ?? []),
		customInstructions: snapshot.customInstructions,
	});
	const promptTokens = approxTokens(prompt.user);
	let messages = boundSummarizationInput(
		pruneToolResults(
			[...snapshot.preparation.messagesToSummarize, ...snapshot.preparation.turnPrefixMessages],
			snapshot.contextWindow,
			SUMMARIZATION_INPUT_BUDGET_RATIO,
		),
		snapshot.contextWindow,
		promptTokens,
	);
	const overflowRetryStartMs = Date.now();
	let overflowAttempts = 0;

	while (true) {
		if (signal?.aborted) return undefined;
		const response = await generateSummaryMessage({
			context,
			messages,
			onProgress,
			prompt,
			signal,
			snapshot,
			auth: {
				apiKey: auth.apiKey,
				headers: auth.headers,
				extraBody: auth.extraBody,
			},
		});
		if (!response) return undefined;

		if (isAssistantMessage(response) && isContextOverflow(response, snapshot.contextWindow)) {
			overflowAttempts++;
			const elapsedMs = Date.now() - overflowRetryStartMs;
			const retryMessages = allowOverflowRetry(overflowAttempts, elapsedMs)
				? shrinkSummarizationInputForOverflowRetry(messages, snapshot.contextWindow, promptTokens)
				: undefined;
			if (!retryMessages) {
				throw new SummarizationOverflowExhaustedError(overflowAttempts, elapsedMs);
			}
			messages = retryMessages;
			continue;
		}

		if (isAssistantMessage(response) && response.stopReason === "aborted") {
			// A partial summary from an aborted stream must never be applied.
			return undefined;
		}

		if (isAssistantMessage(response) && response.stopReason === "error") {
			// Surface the real provider failure instead of silently degrading
			// into a generic "Compaction cancelled". Preserve the structured
			// truncation class here so downstream recovery never trusts arbitrary
			// thrown error text as authorization for destructive context reduction.
			const failureKind = summaryRequestFailureKind(response);
			throw new SummaryRequestError(
				response.errorMessage || "Compaction summary request failed",
				failureKind !== undefined || isRetryableAssistantError(response),
				failureKind,
			);
		}

		const summary = getSummaryText(response);
		if (!summary) {
			const stopReason = isAssistantMessage(response) ? response.stopReason : "unknown";
			throw new SummaryGenerationError(
				"empty-summary",
				`summarization response contained no text (stopReason: ${stopReason})`,
			);
		}

		// Informational only: the core rejects an applied compaction that would
		// still overflow (_wouldCompactionOverflow). Rejecting here based on the
		// size of the *discarded* input made large sessions uncompactable.
		const tokenEstimate = estimateContextTokens(convertToLlm(messages)).tokens + approxTokens(summary);
		const parsedSummary = extractTaskIntent(summary);
		const taskIntent = parsedSummary.taskIntent ?? resolveInheritedTaskIntent(snapshot.branchEntries ?? []);

		return {
			summary: parsedSummary.summaryText,
			firstKeptEntryId: snapshot.preparation.firstKeptEntryId,
			tokensBefore: snapshot.preparation.tokensBefore,
			details: {
				schema: SUMMARY_SCHEMA,
				promptVariant: snapshot.promptVariant,
				tokenEstimate,
				structuralYield: computeStructuralYield({
					previousSummary: snapshot.preparation.previousSummary ?? "",
					messagesToSummarize: snapshot.preparation.messagesToSummarize,
					turnPrefixMessages: snapshot.preparation.turnPrefixMessages,
					summary: parsedSummary.summaryText,
					tokensBefore: snapshot.preparation.tokensBefore,
				}),
				...(snapshot.origin ? { origin: snapshot.origin } : {}),
				...(taskIntent ? { taskIntent } : {}),
			},
		};
	}
}

export async function applyGeneratedCompaction(
	context: SpeculativeCompactionContext,
	snapshot: SpeculativeCompactionSnapshot | undefined,
	getCurrentGeneration: () => number,
	compaction: CompactionResult | undefined,
	signal?: AbortSignal,
): Promise<SpeculativeCompactionResult> {
	if (!snapshot || !compaction) return { applied: false, reason: "unavailable" };

	if (snapshot.generation !== getCurrentGeneration() || snapshot.expectedRevision !== context.getMessageRevision()) {
		return { applied: false, reason: "stale" };
	}

	return await context.applyCompaction(compaction, {
		reason: "extension",
		expectedRevision: snapshot.expectedRevision,
		signal,
	});
}

export async function applySpeculativeCompaction(
	context: SpeculativeCompactionContext,
	snapshot: SpeculativeCompactionSnapshot | undefined,
	getCurrentGeneration: () => number,
	generate: () => Promise<CompactionResult | undefined>,
): Promise<SpeculativeCompactionResult> {
	if (!snapshot) return { applied: false, reason: "unavailable" };

	const compaction = await generate();
	return await applyGeneratedCompaction(context, snapshot, getCurrentGeneration, compaction);
}
