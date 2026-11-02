import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAnthropicCompat } from "../src/api/anthropic-messages.ts";
import { supportsPromptCaching } from "../src/api/bedrock-converse-stream.ts";
import { getCompat as getOpenAICompletionsCompat } from "../src/api/openai-completions.ts";
import { getModels } from "../src/compat.ts";
import {
	type Api,
	type Model,
	PROMPT_CACHE_TTL_LONG_SECONDS,
	PROMPT_CACHE_TTL_OPENAI_EXTENDED_SECONDS,
	PROMPT_CACHE_TTL_SHORT_SECONDS,
	resolvePromptCacheLifetime,
	resolvePromptCacheTtlSeconds,
} from "../src/index.ts";
import { supportsPromptCaching as supportsPromptCachingBrowserSafe } from "../src/utils/prompt-cache-ttl.ts";

function createModel<TApi extends Api>(api: TApi, overrides: Partial<Model<TApi>> = {}): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	} as Model<TApi>;
}

const anthropicModel = createModel("anthropic-messages", {
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com/v1",
});

const anthropicCompletionsModel = createModel("openai-completions", {
	provider: "custom-proxy",
	compat: {
		cacheControlFormat: "anthropic",
		supportsLongCacheRetention: true,
	},
});

const cacheableBedrockModel = createModel("bedrock-converse-stream", {
	id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
	provider: "amazon-bedrock",
});

const openAIResponsesModel = createModel("openai-responses", {
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
});

function catalogModel(provider: Parameters<typeof getModels>[0], id: string): Model<Api> {
	const model = getModels(provider).find((candidate) => candidate.id === id);
	if (model === undefined) throw new Error(`missing catalog model ${provider}/${id}`);
	return model as Model<Api>;
}

const originalCacheRetention = process.env.PI_CACHE_RETENTION;

beforeEach(() => {
	delete process.env.PI_CACHE_RETENTION;
});

afterEach(() => {
	if (originalCacheRetention === undefined) {
		delete process.env.PI_CACHE_RETENTION;
	} else {
		process.env.PI_CACHE_RETENTION = originalCacheRetention;
	}
});

describe("prompt-cache TTL constants", () => {
	it("exports the short and long cache durations from the pi-ai root", () => {
		expect(PROMPT_CACHE_TTL_SHORT_SECONDS).toBe(300);
		expect(PROMPT_CACHE_TTL_LONG_SECONDS).toBe(3600);
		expect(PROMPT_CACHE_TTL_OPENAI_EXTENDED_SECONDS).toBe(1800);
	});
});

// code-yeongyu/senpi#2090: OpenAI documents a >= 30 minute cache lifetime for GPT-5.6 and later.
describe("OpenAI GPT-5.6+ prompt-cache lifetime (#2090)", () => {
	it.each([
		["openai", "gpt-6-luna"],
		["openai", "gpt-6-sol"],
		["openai", "gpt-6-astra-fast"],
		["openai", "gpt-5.6-terra"],
		["chatgpt-subscription", "gpt-6-astra"],
		["chatgpt-subscription", "gpt-5.6-sol"],
		["azure-openai-responses", "gpt-6-sol"],
	] as const)("resolves %s/%s to the documented 30 minutes", (provider, id) => {
		const model = catalogModel(provider, id);

		expect(resolvePromptCacheLifetime(model)).toEqual({ kind: "ttl", ttlSeconds: 1800 });
		expect(resolvePromptCacheTtlSeconds(model)).toBe(1800);
		expect(resolvePromptCacheTtlSeconds(model, { PI_CACHE_RETENTION: "long" })).toBe(1800);
	});

	it.each([
		["openai", "gpt-5.5"],
		["openai", "gpt-5.4-mini"],
		["openai", "o3"],
		["chatgpt-subscription", "gpt-5.5"],
		["azure-openai-responses", "gpt-5.5"],
	] as const)("keeps the short lifetime for pre-5.6 model %s/%s", (provider, id) => {
		expect(resolvePromptCacheTtlSeconds(catalogModel(provider, id))).toBe(300);
	});

	it("returns undefined when caching is disabled on a GPT-6 model", () => {
		const model = { ...catalogModel("openai", "gpt-6-luna"), cacheRetention: "none" as const };

		expect(resolvePromptCacheLifetime(model)).toEqual({ kind: "none" });
		expect(resolvePromptCacheTtlSeconds(model)).toBeUndefined();
	});

	it("applies the model-generation rule to custom models on the OpenAI API host", () => {
		const model = createModel("openai-responses", {
			id: "gpt-6-sol",
			provider: "my-openai",
			baseUrl: "https://api.openai.com/v1",
		});

		expect(resolvePromptCacheTtlSeconds(model)).toBe(1800);
	});

	it("keeps gateways that proxy GPT-6 ids on the conservative short lifetime", () => {
		expect(resolvePromptCacheTtlSeconds(catalogModel("github-copilot", "gpt-6-sol"))).toBe(300);
		expect(
			resolvePromptCacheTtlSeconds(createModel("openai-responses", { id: "gpt-6-sol", provider: "proxy" })),
		).toBe(300);
	});
});

// code-yeongyu/senpi#831: direct DeepSeek caches automatically with no expiry contract.
describe("DeepSeek best-effort prompt cache (#831)", () => {
	it("classifies the catalog DeepSeek model as best-effort with no TTL", () => {
		const model = catalogModel("deepseek", "deepseek-v4-pro");

		expect(resolvePromptCacheLifetime(model)).toEqual({ kind: "best-effort" });
		expect(resolvePromptCacheTtlSeconds(model)).toBeUndefined();
		expect(resolvePromptCacheLifetime({ ...model, cacheRetention: "long" })).toEqual({ kind: "best-effort" });
		expect(resolvePromptCacheLifetime(model, { PI_CACHE_RETENTION: "long" })).toEqual({ kind: "best-effort" });
	});

	it("detects the DeepSeek API host case-insensitively without matching lookalike hosts", () => {
		const direct = createModel("openai-completions", { provider: "custom", baseUrl: "https://API.DeepSeek.com/v1" });
		const lookalike = createModel("openai-completions", {
			provider: "custom",
			baseUrl: "https://api.deepseek.com.example.org/v1",
		});

		expect(resolvePromptCacheLifetime(direct)).toEqual({ kind: "best-effort" });
		expect(resolvePromptCacheTtlSeconds(lookalike)).toBe(300);
	});

	it("lets disabled retention win over best-effort detection", () => {
		const model = { ...catalogModel("deepseek", "deepseek-v4-pro"), cacheRetention: "none" as const };

		expect(resolvePromptCacheLifetime(model)).toEqual({ kind: "none" });
	});
});

describe("retention precedence stays pinned to the API adapters", () => {
	it("lets an explicit model retention override ProviderEnv", () => {
		const env = { PI_CACHE_RETENTION: "long" };

		expect(resolvePromptCacheTtlSeconds({ ...anthropicModel, cacheRetention: "short" }, env)).toBe(300);
		expect(resolvePromptCacheTtlSeconds({ ...anthropicCompletionsModel, cacheRetention: "short" }, env)).toBe(300);
		expect(resolvePromptCacheTtlSeconds({ ...cacheableBedrockModel, cacheRetention: "short" }, env)).toBe(300);
		expect(resolvePromptCacheTtlSeconds({ ...openAIResponsesModel, cacheRetention: "short" }, env)).toBe(300);
	});

	it("honors PI_CACHE_RETENTION=long from ProviderEnv", () => {
		const env = { PI_CACHE_RETENTION: "long" };

		expect(resolvePromptCacheTtlSeconds(anthropicModel, env)).toBe(3600);
		expect(resolvePromptCacheTtlSeconds(anthropicCompletionsModel, env)).toBe(3600);
		expect(resolvePromptCacheTtlSeconds(cacheableBedrockModel, env)).toBe(300);
		expect(resolvePromptCacheTtlSeconds(openAIResponsesModel, env)).toBe(300);
	});

	it("uses the Anthropic process.env-only short branch when the variable is set but not long", () => {
		process.env.PI_CACHE_RETENTION = "legacy-opt-out";

		expect(resolvePromptCacheTtlSeconds(anthropicModel)).toBe(300);
		expect(resolvePromptCacheTtlSeconds(anthropicCompletionsModel)).toBe(300);
		expect(resolvePromptCacheTtlSeconds(cacheableBedrockModel)).toBe(300);
		expect(resolvePromptCacheTtlSeconds(openAIResponsesModel)).toBe(300);
	});

	it("uses each adapter's own unset fallback", () => {
		expect(resolvePromptCacheTtlSeconds(anthropicModel)).toBe(300);
		expect(resolvePromptCacheTtlSeconds(anthropicCompletionsModel)).toBe(300);
		expect(resolvePromptCacheTtlSeconds(cacheableBedrockModel)).toBe(300);
		expect(resolvePromptCacheTtlSeconds(openAIResponsesModel)).toBe(300);
	});
});

describe("Anthropic Messages TTL", () => {
	it("returns one hour for direct Anthropic long retention", () => {
		expect(resolvePromptCacheTtlSeconds({ ...anthropicModel, cacheRetention: "long" })).toBe(3600);
	});

	it("returns five minutes for proxied Anthropic models", () => {
		const proxyModel = {
			...anthropicModel,
			baseUrl: "https://anthropic-proxy.example.com/v1",
			cacheRetention: "long" as const,
		};

		expect(resolvePromptCacheTtlSeconds(proxyModel)).toBe(300);
	});

	it("returns undefined when caching is disabled", () => {
		expect(resolvePromptCacheTtlSeconds({ ...anthropicModel, cacheRetention: "none" })).toBeUndefined();
	});

	it("reuses Anthropic compat defaults for Fireworks-hosted models", () => {
		const fireworksModel = createModel("anthropic-messages", {
			provider: "fireworks",
			baseUrl: "https://api.anthropic.com/v1",
			cacheRetention: "long",
		});

		expect(getAnthropicCompat(fireworksModel).supportsLongCacheRetention).toBe(false);
		expect(resolvePromptCacheTtlSeconds(fireworksModel)).toBe(300);
	});
});

describe("OpenAI Completions TTL", () => {
	it.each([
		"anthropic/claude-sonnet-4",
		"~anthropic/claude-opus-latest",
		"qwen/qwen3-235b-a22b",
		"google/gemini-2.5-pro",
	])("uses resolved OpenRouter cache control compat for %s", (modelId) => {
		const openRouterModel = createModel("openai-completions", {
			id: modelId,
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			cacheRetention: "long",
		});

		expect(getOpenAICompletionsCompat(openRouterModel).cacheControlFormat).toBe("anthropic");
		expect(getOpenAICompletionsCompat(openRouterModel).sendSessionAffinityHeaders).toBe(true);
		expect(resolvePromptCacheTtlSeconds(openRouterModel)).toBe(3600);
	});

	it("does not enable cache control for other OpenRouter model prefixes", () => {
		const openRouterModel = createModel("openai-completions", {
			id: "meta-llama/llama-3.3-70b-instruct",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		});

		expect(getOpenAICompletionsCompat(openRouterModel).cacheControlFormat).toBeUndefined();
	});

	it("selects Moonshot tool schema normalization and prompt cache keys automatically", () => {
		const moonshotModel = createModel("openai-completions", {
			provider: "moonshotai",
			baseUrl: "https://api.moonshot.ai/v1",
		});

		expect(getOpenAICompletionsCompat(moonshotModel).toolSchemaFlavor).toBe("moonshot-mfjs");
		expect(getOpenAICompletionsCompat(moonshotModel).supportsPromptCacheKey).toBe(true);
	});

	it("preserves an explicit Moonshot prompt cache key override", () => {
		const moonshotModel = createModel("openai-completions", {
			provider: "moonshotai",
			baseUrl: "https://api.moonshot.ai/v1",
			compat: { supportsPromptCacheKey: false },
		});

		expect(getOpenAICompletionsCompat(moonshotModel).supportsPromptCacheKey).toBe(false);
	});

	it("preserves an explicit tool schema normalization override", () => {
		const customModel = createModel("openai-completions", {
			provider: "custom",
			baseUrl: "https://example.com/v1",
			compat: { toolSchemaFlavor: "moonshot-mfjs" },
		});

		expect(getOpenAICompletionsCompat(customModel).toolSchemaFlavor).toBe("moonshot-mfjs");
	});

	it("uses a conservative five minutes for OpenAI-style automatic caching", () => {
		const model = createModel("openai-completions", {
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			cacheRetention: "long",
		});

		expect(resolvePromptCacheTtlSeconds(model)).toBe(300);
	});
});

describe("Bedrock Converse TTL", () => {
	it("keeps the browser-safe predicate aligned with the Bedrock API export", () => {
		const unsupportedModel = createModel("bedrock-converse-stream", {
			id: "meta.llama3-70b-instruct-v1:0",
			provider: "amazon-bedrock",
		});
		const forcedModel = createModel("bedrock-converse-stream", {
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/custom-profile",
			provider: "amazon-bedrock",
		});
		const forceEnv = { AWS_BEDROCK_FORCE_CACHE: "1" };

		expect(supportsPromptCachingBrowserSafe(cacheableBedrockModel)).toBe(
			supportsPromptCaching(cacheableBedrockModel),
		);
		expect(supportsPromptCachingBrowserSafe(unsupportedModel)).toBe(supportsPromptCaching(unsupportedModel));
		expect(supportsPromptCachingBrowserSafe(forcedModel, forceEnv)).toBe(
			supportsPromptCaching(forcedModel, forceEnv),
		);
	});

	it("returns five minutes for a cacheable Claude 3.7 model with long retention", () => {
		expect(resolvePromptCacheTtlSeconds({ ...cacheableBedrockModel, cacheRetention: "long" })).toBe(300);
	});

	it("returns undefined for a model without explicit prompt caching support", () => {
		const model = createModel("bedrock-converse-stream", {
			id: "meta.llama3-70b-instruct-v1:0",
			provider: "amazon-bedrock",
			cacheRetention: "long",
		});

		expect(supportsPromptCaching(model)).toBe(false);
		expect(resolvePromptCacheTtlSeconds(model)).toBeUndefined();
	});

	it("honors AWS_BEDROCK_FORCE_CACHE from ProviderEnv", () => {
		const model = createModel("bedrock-converse-stream", {
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/custom-profile",
			provider: "amazon-bedrock",
			cacheRetention: "long",
		});
		const env = { AWS_BEDROCK_FORCE_CACHE: "1" };

		expect(supportsPromptCaching(model, env)).toBe(true);
		expect(resolvePromptCacheTtlSeconds(model, env)).toBe(300);
	});
});

describe("automatic and unknown cache backends", () => {
	describe("Claude SDK OAuth lane follows the TTL Claude Code picks", () => {
		const model = createModel("claude-sdk-oauth", {
			provider: "anthropic-subscription",
			baseUrl: "claude-sdk-oauth",
		});
		const billingEnv = [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"CLAUDE_CODE_USE_FOUNDRY",
			"CLAUDE_CODE_PROMPT_CACHE_TTL",
			"FORCE_PROMPT_CACHING_5M",
			"ENABLE_PROMPT_CACHING_1H",
		];
		const saved = new Map<string, string | undefined>();
		beforeEach(() => {
			for (const name of billingEnv) {
				saved.set(name, process.env[name]);
				delete process.env[name];
			}
		});
		afterEach(() => {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		});

		it("returns one hour on a subscription, whatever senpi's own retention setting says", () => {
			expect(resolvePromptCacheTtlSeconds(model, {})).toBe(3600);
			expect(resolvePromptCacheTtlSeconds(model, { PI_CACHE_RETENTION: "short" })).toBe(3600);
		});

		it.each([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"CLAUDE_CODE_USE_FOUNDRY",
		])("returns five minutes when %s puts Claude Code on API, gateway or cloud billing", (name) => {
			expect(resolvePromptCacheTtlSeconds(model, { [name]: "1" })).toBe(300);
		});

		it("honors Claude Code's own TTL overrides", () => {
			expect(resolvePromptCacheTtlSeconds(model, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })).toBe(300);
			expect(
				resolvePromptCacheTtlSeconds(model, { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", ANTHROPIC_API_KEY: "k" }),
			).toBe(3600);
			expect(resolvePromptCacheTtlSeconds(model, { FORCE_PROMPT_CACHING_5M: "1" })).toBe(300);
			expect(resolvePromptCacheTtlSeconds(model, { ENABLE_PROMPT_CACHING_1H: "1", ANTHROPIC_API_KEY: "k" })).toBe(
				3600,
			);
		});
	});

	it.each(["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const)(
		"returns five minutes for %s",
		(api) => {
			expect(resolvePromptCacheTtlSeconds(createModel(api))).toBe(300);
		},
	);

	it("returns undefined for disabled OpenAI Responses caching", () => {
		expect(resolvePromptCacheTtlSeconds(createModel("openai-responses", { cacheRetention: "none" }))).toBeUndefined();
	});

	it.each(["google-generative-ai", "google-vertex", "mistral-conversations", "pi-messages", "unknown-api"] as const)(
		"returns undefined for %s",
		(api) => {
			expect(resolvePromptCacheTtlSeconds(createModel(api))).toBeUndefined();
			expect(resolvePromptCacheLifetime(createModel(api))).toEqual({ kind: "none" });
		},
	);
});
