import type {
	AnthropicMessagesCompat,
	Api,
	CacheRetention,
	Model,
	OpenAICompletionsCompat,
	ProviderEnv,
} from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

export const PROMPT_CACHE_TTL_SHORT_SECONDS = 300;
export const PROMPT_CACHE_TTL_LONG_SECONDS = 3600;

export function isAnthropicApiBaseUrl(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}

const CLAUDE_FABLE_OR_MYTHOS_MODEL_ID = /^claude-(?:fable|mythos)(?:-|$)/i;

/**
 * Default for `supportsToolReferences`: first-party Anthropic models except
 * Haiku (rejects client-side tool_reference blocks) and models that predate
 * tool search (Claude 3.x, Opus/Sonnet 4.0, Opus 4.1).
 */
function defaultSupportsToolReferences(model: Model<"anthropic-messages">): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

export function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<Omit<AnthropicMessagesCompat, "forceAdaptiveThinking">> {
	// Auto-detect session affinity and cache control support from provider
	const isFireworks = model.provider === "fireworks";
	const isCloudflareAiGatewayAnthropic =
		model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
	const isXiaomi = model.provider === "xiaomi" || model.provider.startsWith("xiaomi-token-plan-");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
		sendSessionAffinityHeaders:
			model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayAnthropic),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
		supportsDisabledThinking: model.compat?.supportsDisabledThinking ?? !isXiaomi,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		supportsToolChoice: model.compat?.supportsToolChoice ?? true,
		supportsForcedToolChoice:
			model.compat?.supportsForcedToolChoice ?? !CLAUDE_FABLE_OR_MYTHOS_MODEL_ID.test(model.id),
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		unsignedThinkingReplay:
			model.compat?.unsignedThinkingReplay ?? (model.compat?.allowEmptySignature ? "empty-signature" : "text"),
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsToolReferences: model.compat?.supportsToolReferences ?? defaultSupportsToolReferences(model),
		// Default: first-party Anthropic only. Anthropic-compatible providers
		// (kimi-coding, fireworks, copilot, gateways) may execute the server-side
		// search but reject the replayed server_tool_use / web_search_tool_result
		// blocks on the next request (kimi-coding 400s with `tool_call_id is not
		// found`).
		supportsWebSearch: model.compat?.supportsWebSearch ?? isAnthropicApiBaseUrl(model.baseUrl),
	};
}

export type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	"cacheControlFormat" | "toolCallFormat" | "deferredToolsMode" | "toolSchemaFlavor"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	toolCallFormat?: OpenAICompletionsCompat["toolCallFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	toolSchemaFlavor?: OpenAICompletionsCompat["toolSchemaFlavor"];
};

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 * Returns a fully resolved OpenAICompletionsCompat object with all fields set.
 */
function detectOpenAICompletionsCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");

	const isNonStandard =
		isNvidia ||
		provider === "cerebras" ||
		baseUrl.includes("cerebras.ai") ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("deepseek.com") ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		zaiToolStream: false,
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
		toolSchemaFlavor: isMoonshot ? "moonshot-mfjs" : undefined,
		supportsDisabledThinking: true,
		toolCallFormat: undefined,
		supportsOpenAIGrammarTools: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: false,
		deferredToolsMode: undefined,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

/**
 * Get resolved compatibility settings for a model.
 * Auto-detects from provider/URL then overrides with explicit model.compat.
 */
export function getOpenAICompletionsCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const detected = detectOpenAICompletionsCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages:
			model.compat.requiresReasoningContentOnAssistantMessages ??
			detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		supportsDisabledThinking: model.compat.supportsDisabledThinking ?? detected.supportsDisabledThinking,
		openRouterRouting: model.compat.openRouterRouting ?? detected.openRouterRouting,
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		toolSchemaFlavor: model.compat.toolSchemaFlavor ?? detected.toolSchemaFlavor,
		toolCallFormat: model.compat.toolCallFormat ?? detected.toolCallFormat,
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		deferredToolsMode: model.compat.deferredToolsMode ?? detected.deferredToolsMode,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
	};
}

export function getBedrockModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

/**
 * Check if the model supports prompt caching.
 * Supported: Claude 3.5 Haiku, Claude 3.7 Sonnet, Claude 4.x models, Claude 5 models
 *
 * For base models and system-defined inference profiles the model ID / ARN
 * contains the model name, so we can decide locally.
 *
 * For application inference profiles (whose ARNs don't contain the model name),
 * also checks model.name which is user-controlled via models.json or registerProvider.
 * As a last resort, set AWS_BEDROCK_FORCE_CACHE=1 to enable cache points.
 * Amazon Nova models have automatic caching and don't need explicit cache points.
 */
export function supportsPromptCaching(model: Model<"bedrock-converse-stream">, env?: ProviderEnv): boolean {
	const candidates = getBedrockModelMatchCandidates(model.id, model.name);

	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	if (!hasClaudeRef) {
		// Application inference profiles don't contain the model name in the ARN.
		// Allow users to force cache points via environment variable.
		if (getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", env) === "1") return true;
		return false;
	}
	// Claude 5 models (fable-5, opus-5, sonnet-5)
	if (candidates.some((s) => s.includes("fable-5") || s.includes("opus-5") || s.includes("sonnet-5"))) return true;
	// Claude 4.x models (opus-4, sonnet-4, haiku-4)
	if (candidates.some((s) => s.includes("-4-"))) return true;
	// Claude 3.7 Sonnet
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	// Claude 3.5 Haiku
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	return false;
}

function resolveAnthropicCacheRetention(
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
	fallback: CacheRetention = "short",
): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION !== undefined) {
		return "short";
	}
	return fallback;
}

function resolveOpenAICompletionsCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function resolveBedrockCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function resolveOpenAIResponsesCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

export function resolvePromptCacheTtlSeconds(model: Model<Api>, env?: ProviderEnv): number | undefined {
	switch (model.api) {
		case "anthropic-messages": {
			const anthropicModel = model as Model<"anthropic-messages">;
			const retention = resolveAnthropicCacheRetention(anthropicModel.cacheRetention, env, "long");
			if (retention === "none") return undefined;
			return retention === "long" &&
				isAnthropicApiBaseUrl(anthropicModel.baseUrl) &&
				getAnthropicCompat(anthropicModel).supportsLongCacheRetention
				? PROMPT_CACHE_TTL_LONG_SECONDS
				: PROMPT_CACHE_TTL_SHORT_SECONDS;
		}
		case "bedrock-converse-stream": {
			const bedrockModel = model as Model<"bedrock-converse-stream">;
			const retention = resolveBedrockCacheRetention(bedrockModel.cacheRetention, env);
			if (retention === "none" || !supportsPromptCaching(bedrockModel, env)) return undefined;
			return retention === "long" ? PROMPT_CACHE_TTL_LONG_SECONDS : PROMPT_CACHE_TTL_SHORT_SECONDS;
		}
		case "openai-completions": {
			const completionsModel = model as Model<"openai-completions">;
			const retention = resolveOpenAICompletionsCacheRetention(completionsModel.cacheRetention, env);
			if (retention === "none") return undefined;
			const compat = getOpenAICompletionsCompat(completionsModel);
			if (compat.cacheControlFormat === "anthropic") {
				return retention === "long" && compat.supportsLongCacheRetention
					? PROMPT_CACHE_TTL_LONG_SECONDS
					: PROMPT_CACHE_TTL_SHORT_SECONDS;
			}
			return PROMPT_CACHE_TTL_SHORT_SECONDS;
		}
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses": {
			const retention = resolveOpenAIResponsesCacheRetention(model.cacheRetention, env);
			return retention === "none" ? undefined : PROMPT_CACHE_TTL_SHORT_SECONDS;
		}
		default:
			return undefined;
	}
}
