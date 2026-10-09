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
/**
 * OpenAI GPT-5.6 and later: `prompt_cache_options.ttl` accepts only `"30m"`, and the cache stays
 * eligible at least 30 minutes after the latest write or reuse.
 */
export const PROMPT_CACHE_TTL_OPENAI_EXTENDED_SECONDS = 1800;

/**
 * How long a provider promises to keep a prompt prefix cached.
 *
 * - `ttl`: an explicit expiry contract; `ttlSeconds` is the conservative lifetime after the last write or reuse.
 * - `best-effort`: the provider caches automatically but promises no expiry (direct DeepSeek clears unused entries
 *   after hours to days), so nothing needs to wake or ping solely to preserve the cache.
 * - `none`: caching is disabled or the lane has no known cache contract.
 */
export type PromptCacheLifetime =
	| { readonly kind: "ttl"; readonly ttlSeconds: number }
	| { readonly kind: "best-effort" }
	| { readonly kind: "none" };

const NO_PROMPT_CACHE: PromptCacheLifetime = { kind: "none" };
const BEST_EFFORT_PROMPT_CACHE: PromptCacheLifetime = { kind: "best-effort" };

function ttl(ttlSeconds: number): PromptCacheLifetime {
	return { kind: "ttl", ttlSeconds };
}

function hostnameOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

export function isAnthropicApiBaseUrl(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}

/**
 * Families that reject forced tool use (`tool_choice` `any` / `tool` return 400): every Fable and
 * Mythos release, Claude Opus 5.5 and Claude Sonnet 5.5 (`claude-opus-5-5`, `claude-sonnet-5-5`;
 * gateways may spell them with a dot).
 */
const FORCED_TOOL_CHOICE_REJECTING_MODEL_ID = /^claude-(?:(?:fable|mythos)(?:-|$)|(?:opus|sonnet)-5[.-]5(?:[.-]|$))/i;

/**
 * Default for `supportsToolReferences`: first-party Anthropic models except
 * Haiku (rejects client-side tool_reference blocks) and models that predate
 * tool search (Claude 3.x, Opus/Sonnet 4.0, Opus 4.1). Haiku 5.5 is listed in
 * Anthropic's tool-search table, as Haiku 4.5 is, but stays off until a live
 * probe confirms it (senpi#2914).
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
): Required<
	Omit<AnthropicMessagesCompat, "forceAdaptiveThinking" | "supportsMidConvoEffort" | "sessionAffinityFormat">
> &
	Pick<AnthropicMessagesCompat, "sessionAffinityFormat"> {
	// Auto-detect session affinity and cache control support from provider
	const isFireworks = model.provider === "fireworks";
	const isCloudflareAiGatewayAnthropic =
		model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
	const isXiaomi = model.provider === "xiaomi" || model.provider.startsWith("xiaomi-token-plan-");
	// OpenRouter carries prompt-cache affinity on its own x-session-id header and
	// rejects x-session-affinity (earendil-works/pi#9102).
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
		sendSessionAffinityHeaders:
			model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayAnthropic || isOpenRouter),
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (isOpenRouter ? "openrouter" : undefined),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
		supportsDisabledThinking: model.compat?.supportsDisabledThinking ?? !isXiaomi,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		supportsToolChoice: model.compat?.supportsToolChoice ?? true,
		supportsForcedToolChoice:
			model.compat?.supportsForcedToolChoice ?? !FORCED_TOOL_CHOICE_REJECTING_MODEL_ID.test(model.id),
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		unsignedThinkingReplay:
			model.compat?.unsignedThinkingReplay ?? (model.compat?.allowEmptySignature ? "empty-signature" : "text"),
		allowedFallbackModels: model.compat?.allowedFallbackModels ?? [],
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
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
	| "vllmPriority"
	| "cacheControlFormat"
	| "toolCallFormat"
	| "deferredToolsMode"
	| "toolSchemaFlavor"
	| "supportsPromptCacheKey"
	| "chatTemplateArgs"
	| "supportsThinkingTokenBudget"
	| "thinkingTokenBudgetField"
	| "veniceParameters"
	| "supportsForcedToolChoice"
> & {
	/** Declared forced tool_choice support; absent means supported. */
	supportsForcedToolChoice?: OpenAICompletionsCompat["supportsForcedToolChoice"];
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	supportsPromptCacheKey?: OpenAICompletionsCompat["supportsPromptCacheKey"];
	toolCallFormat?: OpenAICompletionsCompat["toolCallFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	toolSchemaFlavor?: OpenAICompletionsCompat["toolSchemaFlavor"];
	chatTemplateArgs?: OpenAICompletionsCompat["chatTemplateArgs"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	/** vLLM `priority`; off by default and never set on the generated catalog. */
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
	/** Venice `venice_parameters`; only set on the generated Venice catalog. */
	veniceParameters?: OpenAICompletionsCompat["veniceParameters"];
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
	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	const isNonStandard =
		isNvidia ||
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const openRouterCacheControlPrefixes = ["anthropic/", "qwen/", "google/"];
	const cacheControlModelId = model.id.startsWith("~") ? model.id.slice(1) : model.id;
	const supportsOpenRouterCacheControl = openRouterCacheControlPrefixes.some((prefix) =>
		cacheControlModelId.startsWith(prefix),
	);
	const cacheControlFormat = provider === "openrouter" && supportsOpenRouterCacheControl ? "anthropic" : undefined;

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
		// OpenAI compatibility alone does not imply strict JSON-schema tool support.
		supportsStrictMode: false,
		toolSchemaFlavor: isMoonshot ? "moonshot-mfjs" : undefined,
		supportsDisabledThinking: true,
		toolCallFormat: undefined,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: isOpenRouter,
		deferredToolsMode: undefined,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		supportsPromptCacheKey: isMoonshot || baseUrl.includes("api.openai.com"),
		supportsMaxOutputTokens: true,
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
		chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsThinkingTokenBudget: model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
		thinkingTokenBudgetField: model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		toolSchemaFlavor: model.compat.toolSchemaFlavor ?? detected.toolSchemaFlavor,
		toolCallFormat: model.compat.toolCallFormat ?? detected.toolCallFormat,
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		supportsMidConvoSystemMessages:
			model.compat.supportsMidConvoSystemMessages ?? detected.supportsMidConvoSystemMessages,
		supportsMidConvoToolAdditions:
			model.compat.supportsMidConvoToolAdditions ?? detected.supportsMidConvoToolAdditions,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		deferredToolsMode: model.compat.deferredToolsMode ?? detected.deferredToolsMode,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsPromptCacheKey: model.compat.supportsPromptCacheKey ?? detected.supportsPromptCacheKey,
		supportsMaxOutputTokens: model.compat.supportsMaxOutputTokens ?? detected.supportsMaxOutputTokens,
		supportsForcedToolChoice: model.compat.supportsForcedToolChoice,
		vllmPriority: model.compat.vllmPriority ?? detected.vllmPriority,
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

export function supportsOneHourCacheTtl(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getBedrockModelMatchCandidates(model.id, model.name);
	return candidates.some((candidate) =>
		["opus-4-5", "sonnet-4-5", "haiku-4-5"].some((modelVersion) => candidate.includes(modelVersion)),
	);
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

/** Direct DeepSeek API: its automatic disk cache is best-effort and carries no expiry contract. */
function isDirectDeepSeekModel(model: Model<"openai-completions">): boolean {
	return model.provider === "deepseek" || hostnameOf(model.baseUrl) === "api.deepseek.com";
}

/** GPT-5.6 and later (`gpt-5.6-*`, `gpt-5.10`, `gpt-6-*`, `gpt-7`, ...). */
const OPENAI_EXTENDED_CACHE_MODEL_ID = /^gpt-(?:5\.(?:[6-9]|\d{2,})|(?:[6-9]|\d{2,})(?:\.\d+)?)(?:-|$)/i;

/**
 * The OpenAI-operated Responses lanes (OpenAI API, Azure OpenAI, ChatGPT subscription) serving a GPT-5.6+
 * model, where OpenAI documents a cache lifetime of at least 30 minutes. Gateways that merely proxy the same
 * model ids keep the conservative short lifetime because their routing does not carry that contract.
 */
function hasOpenAIExtendedPromptCache(model: Model<Api>): boolean {
	if (model.api === "openai-responses") {
		const responsesModel = model as Model<"openai-responses">;
		if (responsesModel.compat?.supportsExplicitPromptCacheMode === true) return true;
		if (responsesModel.provider !== "openai" && hostnameOf(responsesModel.baseUrl) !== "api.openai.com") return false;
	}
	return OPENAI_EXTENDED_CACHE_MODEL_ID.test(model.id);
}

/** Env that puts Claude Code on API-key, gateway or cloud billing, where it caches the main conversation for 5 minutes. */
const CLAUDE_CODE_API_BILLING_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
] as const;

function isEnabledFlag(value: string | undefined): boolean {
	return value !== undefined && !/^(?:|0|false|no|off)$/i.test(value.trim());
}

/**
 * The Claude SDK lane's cache TTL is chosen by Claude Code, not senpi: `CLAUDE_CODE_PROMPT_CACHE_TTL`
 * (`5m` | `1h`) wins, then `FORCE_PROMPT_CACHING_5M` and `ENABLE_PROMPT_CACHING_1H`; otherwise a Claude
 * subscription gets 1 hour and API-key, gateway or cloud billing gets 5 minutes. A subscription past its
 * usage limits also drops to 5 minutes, which nothing here can observe.
 */
function claudeCodePromptCacheTtlSeconds(env: ProviderEnv | undefined): number {
	const explicit = getProviderEnvValue("CLAUDE_CODE_PROMPT_CACHE_TTL", env)?.trim().toLowerCase();
	if (explicit === "5m") return PROMPT_CACHE_TTL_SHORT_SECONDS;
	if (explicit === "1h") return PROMPT_CACHE_TTL_LONG_SECONDS;
	if (isEnabledFlag(getProviderEnvValue("FORCE_PROMPT_CACHING_5M", env))) return PROMPT_CACHE_TTL_SHORT_SECONDS;
	if (isEnabledFlag(getProviderEnvValue("ENABLE_PROMPT_CACHING_1H", env))) return PROMPT_CACHE_TTL_LONG_SECONDS;
	return CLAUDE_CODE_API_BILLING_ENV.some((name) => getProviderEnvValue(name, env) !== undefined)
		? PROMPT_CACHE_TTL_SHORT_SECONDS
		: PROMPT_CACHE_TTL_LONG_SECONDS;
}

/**
 * Classify the active model's prompt-cache lifetime from the provider's documented cache contract.
 * `cacheRetention: "none"` (or `PI_CACHE_RETENTION` resolving to it) always wins.
 */
export function resolvePromptCacheLifetime(model: Model<Api>, env?: ProviderEnv): PromptCacheLifetime {
	switch (model.api) {
		case "claude-sdk-oauth":
			return ttl(claudeCodePromptCacheTtlSeconds(env));
		case "anthropic-messages": {
			const anthropicModel = model as Model<"anthropic-messages">;
			const retention = resolveAnthropicCacheRetention(anthropicModel.cacheRetention, env, "short");
			if (retention === "none") return NO_PROMPT_CACHE;
			return retention === "long" &&
				isAnthropicApiBaseUrl(anthropicModel.baseUrl) &&
				getAnthropicCompat(anthropicModel).supportsLongCacheRetention
				? ttl(PROMPT_CACHE_TTL_LONG_SECONDS)
				: ttl(PROMPT_CACHE_TTL_SHORT_SECONDS);
		}
		case "bedrock-converse-stream": {
			const bedrockModel = model as Model<"bedrock-converse-stream">;
			const retention = resolveBedrockCacheRetention(bedrockModel.cacheRetention, env);
			if (retention === "none" || !supportsPromptCaching(bedrockModel, env)) return NO_PROMPT_CACHE;
			return retention === "long" && supportsOneHourCacheTtl(bedrockModel)
				? ttl(PROMPT_CACHE_TTL_LONG_SECONDS)
				: ttl(PROMPT_CACHE_TTL_SHORT_SECONDS);
		}
		case "openai-completions": {
			const completionsModel = model as Model<"openai-completions">;
			const retention = resolveOpenAICompletionsCacheRetention(completionsModel.cacheRetention, env);
			if (retention === "none") return NO_PROMPT_CACHE;
			if (isDirectDeepSeekModel(completionsModel)) return BEST_EFFORT_PROMPT_CACHE;
			const compat = getOpenAICompletionsCompat(completionsModel);
			if (compat.cacheControlFormat === "anthropic") {
				return retention === "long" && compat.supportsLongCacheRetention
					? ttl(PROMPT_CACHE_TTL_LONG_SECONDS)
					: ttl(PROMPT_CACHE_TTL_SHORT_SECONDS);
			}
			return ttl(PROMPT_CACHE_TTL_SHORT_SECONDS);
		}
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses": {
			const retention = resolveOpenAIResponsesCacheRetention(model.cacheRetention, env);
			if (retention === "none") return NO_PROMPT_CACHE;
			return hasOpenAIExtendedPromptCache(model)
				? ttl(PROMPT_CACHE_TTL_OPENAI_EXTENDED_SECONDS)
				: ttl(PROMPT_CACHE_TTL_SHORT_SECONDS);
		}
		default:
			return NO_PROMPT_CACHE;
	}
}

/**
 * Explicit prompt-cache TTL in seconds, or `undefined` when the lane has no expiry contract: caching disabled,
 * unknown, or automatic best-effort (see {@link resolvePromptCacheLifetime}).
 */
export function resolvePromptCacheTtlSeconds(model: Model<Api>, env?: ProviderEnv): number | undefined {
	const lifetime = resolvePromptCacheLifetime(model, env);
	return lifetime.kind === "ttl" ? lifetime.ttlSeconds : undefined;
}
