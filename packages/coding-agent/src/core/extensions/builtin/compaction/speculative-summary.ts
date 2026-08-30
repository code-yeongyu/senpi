import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type ProviderHeaders,
	type StreamOptions,
	sanitizeAnthropicToolPairs as sanitizeAnthropicPayload,
	type TextContent,
} from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/compat";
import {
	consumeStreamWithIdleTimeout,
	DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS,
	DEFAULT_SUMMARIZATION_MAX_DURATION_MS,
} from "../../../compaction/stream-watchdog.ts";
import { convertToLlm } from "../../../messages.ts";
import type { buildPrompt } from "./prompts.ts";
import { repairOrphanedToolResults } from "./repair-tool-pairs.ts";
import type { SpeculativeCompactionContext, SpeculativeCompactionSnapshot } from "./speculative.ts";
import { normalizeSummarizationTurnOrder } from "./summarization-turn-order.ts";

const SUMMARY_TOKEN_HEADROOM = 32_768;
const SUMMARY_CONTEXT_WINDOW_RESERVE_RATIO = 0.5;
type CompactionProgressCallback = (delta: string) => void;

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

export function getSummaryText(message: Message): string {
	const content = Array.isArray(message.content)
		? message.content
		: [{ type: "text" as const, text: message.content }];
	return content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

export function isAssistantMessage(message: Message): message is AssistantMessage {
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

export async function generateSummaryMessage(options: {
	context: SpeculativeCompactionContext;
	messages: AgentMessage[];
	onProgress?: CompactionProgressCallback;
	prompt: ReturnType<typeof buildPrompt>;
	signal?: AbortSignal;
	snapshot: SpeculativeCompactionSnapshot;
	auth: {
		apiKey?: string;
		headers?: ProviderHeaders;
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
			messages: repairOrphanedToolResults(
				normalizeSummarizationTurnOrder(convertToLlm(providerRequest?.messages ?? requestMessages)),
			),
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
