import OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsNonStreaming,
	ResponseCreateParamsStreaming,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import {
	calculateCost,
	clampThinkingLevel,
	inferOpenAIThinkingLevelMap,
	supportsMax,
	supportsXhigh,
} from "../models.ts";
import { readProviderDiagnostic } from "../provider-diagnostic.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import {
	formatGitHubCopilotToolLimitError,
	limitGitHubCopilotTools,
	recordGitHubCopilotToolLimit,
} from "../utils/github-copilot-tool-limit.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import {
	awaitProviderTransport,
	openAICompatibleProviderDiagnosticFromError,
} from "../utils/provider-diagnostic-sources.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sendWithForcedToolChoiceFallback } from "../utils/tool-choice-fallback.ts";
import { getCurrentTools, getDeclaredTools, normalizeContext, resolveTranscript } from "../utils/transcript.ts";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { withGitHubCopilotFailureNote } from "./github-copilot-errors.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { resolveOpenAIClientAuth } from "./openai-client-auth.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	findPromptCacheComparisonResponseId,
	type OpenAIPromptCacheOptionsPayload,
	withPromptCacheComparison,
} from "./openai-responses-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
	resolveResponsesDeferredToolsMode,
	resolveResponsesToolPlacement,
} from "./openai-responses-shared.ts";
import { buildBaseOptions, clampMaxForOpenAI, OPENAI_RESPONSES_RESERVED_BODY_KEYS } from "./simple-options.ts";
import { startWebSocketLiveness } from "./websocket-liveness.ts";
import { createWebSocketTransportFailure } from "./websocket-transport-failure.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "chatgpt-subscription", "opencode"]);
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const OPENAI_WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const PROMPT_CACHE_PREWARM_TIMEOUT_MS = 30_000;
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

type WebSocketEventType = "open" | "message" | "error" | "close" | "ping" | "pong";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
	ping?(data?: string): void;
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

export interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
}

type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

type MutableResponsesPayload = ResponseCreateParamsStreaming & {
	prompt_cache_options?: OpenAIPromptCacheOptionsPayload;
};

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();

/** True when tool_choice forces a specific tool or mode (anything but "auto"/"none"). */
function isForcedOpenAIResponsesToolChoice(toolChoice: MutableResponsesPayload["tool_choice"] | undefined): boolean {
	return toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none";
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">, env?: ProviderEnv): Required<OpenAIResponsesCompat> {
	const isNativeEndpoint = isOpenAIResponsesNativeEndpoint(model, env);
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsWebSocket: model.compat?.supportsWebSocket ?? isNativeEndpoint,
		supportsRemoteCompactionV2: model.compat?.supportsRemoteCompactionV2 ?? isNativeEndpoint,
		supportsWebSearchPreview: model.compat?.supportsWebSearchPreview ?? isNativeEndpoint,
		supportsImageGeneration: model.compat?.supportsImageGeneration ?? isNativeEndpoint,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsConfigurationUpdate: model.compat?.supportsConfigurationUpdate ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsForcedToolChoice: model.compat?.supportsForcedToolChoice ?? true,
		supportsAllowedTools: model.compat?.supportsAllowedTools ?? false,
	};
}

function isOpenAIResponsesNativeEndpoint(model: Model<"openai-responses">, env?: ProviderEnv): boolean {
	const baseUrl = isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model, env) : model.baseUrl;
	try {
		return new URL(baseUrl || "https://api.openai.com/v1").hostname === "api.openai.com";
	} catch {
		return false;
	}
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): OpenAIPromptCacheOptionsPayload | undefined {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOpenAiWebSearchPreviewTool(value: unknown): boolean {
	return isRecord(value) && (value.type === "web_search_preview" || value.type === "web_search_preview_2025_03_11");
}

function sanitizeUnsupportedNativeTools(
	params: MutableResponsesPayload,
	compat: Required<OpenAIResponsesCompat>,
): MutableResponsesPayload {
	if (compat.supportsWebSearchPreview) {
		return params;
	}

	const payload = params as MutableResponsesPayload;
	let sanitized: MutableResponsesPayload | undefined;
	const nextPayload = (): MutableResponsesPayload => {
		sanitized ??= { ...payload };
		return sanitized;
	};

	if (Array.isArray(payload.tools)) {
		const tools = payload.tools.filter((tool) => !isOpenAiWebSearchPreviewTool(tool));
		if (tools.length !== payload.tools.length) {
			const next = nextPayload();
			if (tools.length > 0) {
				next.tools = tools;
			} else {
				delete next.tools;
			}
		}
	}

	if (Array.isArray(payload.include)) {
		const include = payload.include.filter((value) => value !== OPENAI_WEB_SEARCH_SOURCES_INCLUDE);
		if (include.length !== payload.include.length) {
			const next = nextPayload();
			if (include.length > 0) {
				next.include = include;
			} else {
				delete next.include;
			}
		}
	}

	if (isOpenAiWebSearchPreviewTool(payload.tool_choice)) {
		delete nextPayload().tool_choice;
	}

	return sanitized ? (sanitized as ResponseCreateParamsStreaming) : params;
}

type AllowedToolReference = { [key: string]: unknown };

function allowedReference(tool: OpenAITool): AllowedToolReference {
	if (tool.type === "function" || tool.type === "custom") return { type: tool.type, name: tool.name };
	if (tool.type === "mcp") return { type: "mcp", server_label: tool.server_label };
	return { type: tool.type };
}

/**
 * senpi#2095: `tools` carries every tool declared this session, so removing a tool never rewrites the
 * cached prefix; the callable subset rides `tool_choice: allowed_tools` instead. Hosted tools a payload
 * hook added stay callable, and deferred tools (declared by transcript items rather than `tools`) are
 * referenced by name. A declared tool a payload hook removed from `tools` is not referenced (senpi#2234).
 * An empty subset forbids tool calls. An explicit `tool_choice` always wins.
 */
function applyAllowedToolsChoice<TParams extends ResponseCreateParamsStreaming>(
	params: TParams,
	context: TranscriptContext,
	activeToolNames: readonly string[] | undefined,
	compat: Required<OpenAIResponsesCompat>,
): TParams {
	if (!compat.supportsAllowedTools || activeToolNames === undefined || params.tool_choice !== undefined) {
		return params;
	}
	const active = new Set(activeToolNames);
	const declaredTools = getCurrentTools(context.messages);
	if (declaredTools.every((tool) => active.has(tool.name))) return params;

	const allowed: AllowedToolReference[] = [];
	const namedInTools = new Set<string>();
	for (const tool of params.tools ?? []) {
		if (tool.type === "function" || tool.type === "custom") {
			namedInTools.add(tool.name);
			if (!active.has(tool.name)) continue;
		}
		allowed.push(allowedReference(tool));
	}
	// Tools missing from the request-level `tools` placement are the ones transcript items load in place.
	const requestToolNames = new Set(
		resolveResponsesToolPlacement(
			context.messages,
			resolveResponsesDeferredToolsMode(compat) !== undefined,
		).requestTools.map((tool) => tool.name),
	);
	for (const tool of declaredTools) {
		if (namedInTools.has(tool.name) || !active.has(tool.name) || requestToolNames.has(tool.name)) continue;
		const [converted] = convertResponsesTools([tool], {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
		if (converted) allowed.push(allowedReference(converted));
	}

	const toolChoice: ResponseCreateParamsStreaming["tool_choice"] =
		allowed.length > 0 ? { type: "allowed_tools", mode: "auto", tools: allowed } : "none";
	return { ...params, tool_choice: toolChoice };
}

function formatOpenAIResponsesError(error: unknown, provider: string): string {
	const errorMessage = formatProviderError(
		normalizeProviderError(error),
		`${provider === "openai" ? "OpenAI" : provider} API error`,
	);
	// Sign in with ChatGPT shares the subscription's usage limit with other apps.
	return errorMessage.includes("subscription_sharing_usage_limit_exceeded")
		? `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`
		: errorMessage;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"] | "fast" | "ultrafast";
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	// Start async processing
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const clientAuth = resolveOpenAIClientAuth(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const compat = getCompat(model, options?.env);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(
				model,
				normalizedContext,
				clientAuth.apiKey,
				clientAuth.headers,
				options?.fetch,
				cacheSessionId,
				options?.env,
			);
			let params = buildParams(model, normalizedContext, options, compat, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MutableResponsesPayload;
			}

			params = sanitizeUnsupportedNativeTools(params, compat);
			params = applyAllowedToolsChoice(params, normalizedContext, context.activeToolNames, compat);
			const limitedTools = limitGitHubCopilotTools(model.provider, params.tools, params.tool_choice);
			if (limitedTools.omittedCount > 0) {
				params = { ...params, tools: limitedTools.tools };
				recordGitHubCopilotToolLimit(output, limitedTools.omittedCount);
			}
			const transport = options?.transport ?? "sse";
			if (transport !== "sse" && compat.supportsWebSocket) {
				let websocketStarted = false;
				try {
					await processWebSocketStream(
						resolveOpenAIResponsesWebSocketUrl(model, options?.env),
						params,
						buildWebSocketHeaders(
							model,
							normalizedContext,
							clientAuth.apiKey,
							clientAuth.headers,
							cacheSessionId,
							options?.env,
						),
						output,
						stream,
						model,
						() => {
							websocketStarted = true;
						},
						cacheSessionId,
						grammarToolInputProperties,
						options,
					);

					if (options?.signal?.aborted) {
						throw new Error("Request was aborted");
					}

					stream.push({ type: "done", reason: getDoneReason(output.stopReason), message: output });
					stream.end();
					return;
				} catch (error) {
					if (transport === "websocket" || websocketStarted) {
						throw error;
					}
				}
			}

			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const createRequest = async () => {
				const sent = await sendWithForcedToolChoiceFallback({
					target: model,
					params,
					acceptsForcedToolChoice: compat.supportsForcedToolChoice,
					isForced: isForcedOpenAIResponsesToolChoice,
					send: (body: MutableResponsesPayload) =>
						model.provider === "github-copilot"
							? awaitProviderTransport(
									() => client.responses.create(body, requestOptions).withResponse(),
									openAICompatibleProviderDiagnosticFromError,
								)
							: client.responses.create(body, requestOptions).withResponse(),
				});
				params = sent.params;
				return sent.result;
			};
			const { data: openaiStream, response } = await retryProviderRequest(() => createRequest(), {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			});
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const providerDiagnostic =
				model.provider === "github-copilot" && output.stopReason === "error"
					? (readProviderDiagnostic(error) ?? openAICompatibleProviderDiagnosticFromError(error))
					: undefined;
			if (providerDiagnostic !== undefined) output.providerDiagnostic = providerDiagnostic;
			output.errorMessage = withGitHubCopilotFailureNote(
				formatGitHubCopilotToolLimitError(output, formatOpenAIResponsesError(error, model.provider)),
				model.provider,
				error,
			);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	resolveOpenAIClientAuth(model.provider, options?.apiKey, options?.headers);
	return stream(model, context, resolveSimpleOptions(model, context, options));
};

function resolveSimpleOptions(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
): OpenAIResponsesOptions {
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
		serviceTier: options?.serviceTier,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort =
		clampedReasoning === "off"
			? undefined
			: clampedReasoning === "max" && supportsMax(model)
				? "max"
				: clampMaxForOpenAI(clampedReasoning, supportsXhigh(model));

	return { ...base, reasoningEffort } satisfies OpenAIResponsesOptions;
}

/**
 * Writes the stable prefix (system prompt + tools, no conversation input) into the
 * OpenAI prompt cache with `prompt_cache_options.prewarm` (senpi#2096). Every other
 * field is built exactly as the next `streamSimple` turn builds it, so the written
 * prefix matches the reasoning effort, service tier, and cache options that turn sends.
 */
export async function warmOpenAIResponsesPromptCache(
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<{ usage: Usage; usageRaw: unknown }> {
	const prefix = normalizeContext({ ...context, messages: [] });
	const resolved = resolveSimpleOptions(model, prefix, options);
	const clientAuth = resolveOpenAIClientAuth(model.provider, resolved.apiKey, resolved.headers);
	const cacheRetention = resolveCacheRetention(resolved.cacheRetention, resolved.env);
	const compat = getCompat(model, resolved.env);
	const grammarToolInputProperties = createGrammarToolInputProperties(
		getDeclaredTools(prefix.messages),
		compat.supportsOpenAIGrammarTools,
	);
	const client = createClient(
		model,
		prefix,
		clientAuth.apiKey,
		clientAuth.headers,
		resolved.fetch,
		cacheRetention === "none" ? undefined : resolved.sessionId,
		resolved.env,
	);
	let params = buildParams(model, prefix, resolved, compat, grammarToolInputProperties);
	const nextParams = await resolved.onPayload?.(params, model);
	if (nextParams !== undefined) params = nextParams as MutableResponsesPayload;
	params = sanitizeUnsupportedNativeTools(params, compat);
	const limitedTools = limitGitHubCopilotTools(model.provider, params.tools, params.tool_choice);
	if (limitedTools.omittedCount > 0) params = { ...params, tools: limitedTools.tools };
	const body = {
		...params,
		stream: false,
		prompt_cache_options: { ...params.prompt_cache_options, prewarm: true },
	} as ResponseCreateParamsNonStreaming;
	const response = await client.responses.create(body, {
		maxRetries: 0,
		timeout: resolved.timeoutMs ?? PROMPT_CACHE_PREWARM_TIMEOUT_MS,
		...(resolved.signal ? { signal: resolved.signal } : {}),
	});
	const usageRaw = response.usage;
	const inputDetails = usageRaw?.input_tokens_details as
		| { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number }
		| undefined;
	const cacheRead = inputDetails?.cached_tokens || 0;
	const cacheWrite = inputDetails?.cache_write_tokens ?? inputDetails?.cache_creation_tokens ?? 0;
	const usage: Usage = {
		input: Math.max(0, (usageRaw?.input_tokens || 0) - cacheRead - cacheWrite),
		output: usageRaw?.output_tokens || 0,
		cacheRead,
		cacheWrite,
		totalTokens: usageRaw?.total_tokens || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	applyServiceTierPricing(usage, response.service_tier ?? resolved.serviceTier, model);
	return { usage, usageRaw };
}

function createClient(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	env?: ProviderEnv,
) {
	const compat = getCompat(model, env);
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model, env) : model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat> = getCompat(model, options?.env),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const toolPlacement = resolveResponsesToolPlacement(
		context.messages,
		resolveResponsesDeferredToolsMode(compat) !== undefined,
	);
	const requestedReasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	const thinkingLevelMap = inferOpenAIThinkingLevelMap(model);
	const mappedReasoningEffort =
		requestedReasoningEffort === undefined ? undefined : thinkingLevelMap?.[requestedReasoningEffort];
	const reasoningEffort = mappedReasoningEffort === undefined ? requestedReasoningEffort : mappedReasoningEffort;
	const reasoningRequested = reasoningEffort !== undefined && reasoningEffort !== null;
	const reasoningUnavailable = reasoningEffort === null;
	const cacheRetention = resolveCacheRetention(options?.cacheRetention ?? model.cacheRetention, options?.env);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		preserveThinking: reasoningRequested,
		// senpi#2096: with a hosted web_search_preview tool the platform reads neither a prewarmed
		// nor a previous prefix unless the system prompt carries an explicit breakpoint.
		systemPromptCacheBreakpoint: compat.supportsExplicitPromptCacheMode && cacheRetention !== "none",
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});

	const isNativeEndpoint = isOpenAIResponsesNativeEndpoint(model, options?.env);
	// senpi#2096: ask the platform why this request missed the prefix of the previous same-model response.
	const comparisonResponseId =
		cacheRetention !== "none" && compat.supportsExplicitPromptCacheMode && isNativeEndpoint
			? findPromptCacheComparisonResponseId(model, context.messages)
			: undefined;
	const params: MutableResponsesPayload = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key:
			cacheRetention === "none" ||
			(isNativeEndpoint && (compat.supportsExplicitPromptCacheMode || model.cost.cacheWrite > 0))
				? undefined
				: clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: withPromptCacheComparison(
			getPromptCacheOptions(compat, cacheRetention),
			comparisonResponseId,
		),
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier as ResponseCreateParamsStreaming["service_tier"];
	}

	if (toolPlacement.requestTools.length > 0) {
		params.tools = convertResponsesTools(toolPlacement.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning) {
		if (reasoningRequested) {
			params.reasoning = {
				effort: reasoningEffort as NonNullable<typeof params.reasoning>["effort"],
				...(options?.reasoningSummary === null ? {} : { summary: options?.reasoningSummary || "auto" }),
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (!reasoningUnavailable && model.provider !== "github-copilot" && thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	applyExtraBodyToResponsesParams(params, options?.extraBody);

	// Last so custom keys override the named request fields. Per-request keys override model defaults.
	Object.assign(params, model.samplingParams, options?.samplingParams);

	return params;
}

function applyExtraBodyToResponsesParams(
	params: ResponseCreateParamsStreaming,
	extraBody: Record<string, unknown> | undefined,
): void {
	if (!extraBody) return;
	for (const [key, value] of Object.entries(extraBody)) {
		if (OPENAI_RESPONSES_RESERVED_BODY_KEYS.has(key)) continue;
		Object.defineProperty(params, key, { value, writable: true, enumerable: true, configurable: true });
	}
}

function getDoneReason(stopReason: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" {
	if (stopReason === "length" || stopReason === "toolUse") return stopReason;
	return "stop";
}

function getWebSocketConstructor(): WebSocketConstructor | null {
	const wsConstructor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
	return typeof wsConstructor === "function" ? wsConstructor : null;
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = (socket as { readyState?: number }).readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	return readyState === undefined || readyState === 1;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

/**
 * Arms the idle-expiry for a cached session socket. A fire while the entry is
 * busy must not strand the entry: the holder may never run the release path
 * that schedules a fresh timer, and a cached-but-forgotten entry would pin its
 * socket for process lifetime. A live busy socket is re-checked on the next
 * tick; a dead one is dropped immediately because nothing can release it.
 */
export function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) {
			if (!isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket, 1000, "idle_timeout_dead");
				websocketSessionCache.delete(sessionId);
				return;
			}
			scheduleSessionWebSocketExpiry(sessionId, entry);
			return;
		}
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		websocketSessionCache.delete(sessionId);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
	const unref = (entry.idleTimer as { unref?: () => void }).unref;
	if (unref) unref.call(entry.idleTimer);
}

/** Number of sessions holding a cached websocket (diagnostics). */
export function getOpenAIResponsesWebSocketCacheSize(): number {
	return websocketSessionCache.size;
}

async function connectWebSocket(url: string, headers: Headers, signal?: AbortSignal): Promise<WebSocketLike> {
	const WebSocketConstructorValue = getWebSocketConstructor();
	if (!WebSocketConstructorValue) {
		throw new Error("WebSocket transport is not available in this runtime");
	}

	const websocketHeaders = headersToRecord(headers);

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let socket: WebSocketLike;

		const cleanup = () => {
			transportFailure.dispose();
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const settleReject = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const transportFailure = createWebSocketTransportFailure(settleReject);
		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			transportFailure.onError(event);
		};
		const onClose: WebSocketListener = (event) => {
			transportFailure.onClose(event);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			closeWebSocketSilently(socket, 1000, "aborted");
			reject(new Error("Request was aborted"));
		};

		try {
			socket = new WebSocketConstructorValue(url, { headers: websocketHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
	});
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	signal?: AbortSignal,
): Promise<{ socket: WebSocketLike; release: (options?: { keep?: boolean }) => void }> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal);
		return { socket, release: () => closeWebSocketSilently(socket) };
	}

	const cached = websocketSessionCache.get(sessionId);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}
		if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						websocketSessionCache.delete(sessionId);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, cached);
				},
			};
		}
		if (!cached.busy) {
			closeWebSocketSilently(cached.socket);
			websocketSessionCache.delete(sessionId);
		}
	}

	const socket = await connectWebSocket(url, headers, signal);
	const entry: CachedWebSocketConnection = { socket, busy: true };
	websocketSessionCache.set(sessionId, entry);
	return {
		socket,
		release: ({ keep } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				if (websocketSessionCache.get(sessionId) === entry) {
					websocketSessionCache.delete(sessionId);
				}
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, entry);
		},
	};
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const arrayBuffer = await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

async function* parseWebSocket(socket: WebSocketLike, signal?: AbortSignal): AsyncGenerator<ResponseStreamEvent> {
	const queue: ResponseStreamEvent[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};
	const liveness = startWebSocketLiveness(socket, (error) => {
		failed = error;
		done = true;
		closeWebSocketSilently(socket, 1000, "liveness_timeout");
		wake();
	});
	const onMessage: WebSocketListener = (event) => {
		liveness.noteActivity();
		void (async () => {
			if (!event || typeof event !== "object" || !("data" in event)) return;
			const text = await decodeWebSocketData((event as { data?: unknown }).data);
			if (!text) return;
			try {
				const parsed = JSON.parse(text) as ResponseStreamEvent;
				if (parsed.type === "response.completed" || parsed.type === "response.incomplete") {
					sawCompletion = true;
					done = true;
				}
				queue.push(parsed);
				wake();
			} catch {}
		})();
	};
	const transportFailure = createWebSocketTransportFailure((error) => {
		if (!failed) failed = error;
		done = true;
		wake();
	});
	const onError: WebSocketListener = (event) => {
		transportFailure.onError(event);
	};
	const onClose: WebSocketListener = (event) => {
		if (sawCompletion) {
			transportFailure.dispose();
			done = true;
			wake();
			return;
		}
		transportFailure.onClose(event);
	};
	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			if (queue.length > 0) {
				const event = queue.shift();
				if (event) yield event;
				continue;
			}
			if (done) break;
			await new Promise<void>((resolve) => {
				pending = resolve;
			});
		}
		if (failed) throw failed;
		if (!sawCompletion) throw new Error("WebSocket stream closed before response.completed");
	} finally {
		liveness.stop();
		transportFailure.dispose();
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function processWebSocketStream(
	url: string,
	params: ResponseCreateParamsStreaming,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-responses">,
	onStart: () => void,
	cacheSessionId: string | undefined,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options?: OpenAIResponsesOptions,
): Promise<void> {
	const { socket, release } = await acquireWebSocket(url, headers, cacheSessionId, options?.signal);
	try {
		socket.send(JSON.stringify({ type: "response.create", ...params }));
		onStart();
		await options?.onResponse?.({ status: 101, headers: {} }, model);
		stream.push({ type: "start", partial: output });
		await processResponsesStream(parseWebSocket(socket, options?.signal), output, stream, model, {
			serviceTier: options?.serviceTier,
			grammarToolInputProperties,
			applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
		});
	} finally {
		release({ keep: false });
	}
}

function resolveOpenAIResponsesWebSocketUrl(model: Model<"openai-responses">, env?: ProviderEnv): string {
	const baseUrl = isCloudflareProvider(model.provider)
		? resolveCloudflareBaseUrl(model, env)
		: model.baseUrl || "https://api.openai.com/v1";
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith("/responses")) {
		url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
	}
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

function buildWebSocketHeaders(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
	env?: ProviderEnv,
): Headers {
	const headers = new Headers(model.headers);
	let suppressDefaultAuthorization = false;
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({ messages: context.messages, hasImages });
		for (const [key, value] of Object.entries(copilotHeaders)) {
			headers.set(key, value);
		}
	}
	for (const [key, value] of Object.entries(optionsHeaders || {})) {
		if (value === null) {
			if (key.toLowerCase() === "authorization") suppressDefaultAuthorization = true;
			headers.delete(key);
		} else {
			headers.set(key, value);
		}
	}
	if (!suppressDefaultAuthorization && !headers.has("Authorization")) {
		headers.set("Authorization", `Bearer ${apiKey}`);
	}
	if (sessionId) {
		const compat = getCompat(model, env);
		if (compat.sessionAffinityFormat === "openai") {
			headers.set("session_id", sessionId);
		}
		if (compat.sessionAffinityFormat === "openai" || compat.sessionAffinityFormat === "openai-nosession") {
			headers.set("x-client-request-id", sessionId);
		} else if (compat.sessionAffinityFormat === "openrouter") {
			headers.set("x-session-id", sessionId);
		}
	}
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	return headers;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id" | "upstreamModelId">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | "fast" | "ultrafast" | undefined,
): number {
	switch (serviceTier) {
		case "ultrafast":
			// OpenAI prices GPT-6 Astra and GPT-6.1 Sol Ultrafast at 6x Standard on every
			// token class and context tier. Any other model keeps its base rate.
			return ["gpt-6-astra", "gpt-6.1-sol"].includes(model.upstreamModelId ?? model.id) ? 6 : 1;
		case "flex":
			return 0.5;
		case "priority":
		case "fast":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | "fast" | "ultrafast" | undefined,
	model: Pick<Model<"openai-responses">, "id" | "upstreamModelId">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
