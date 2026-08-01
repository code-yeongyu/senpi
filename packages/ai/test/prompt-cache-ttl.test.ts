import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAnthropicCompat } from "../src/api/anthropic-messages.ts";
import { supportsPromptCaching } from "../src/api/bedrock-converse-stream.ts";
import { getCompat as getOpenAICompletionsCompat } from "../src/api/openai-completions.ts";
import {
	type Api,
	type Model,
	PROMPT_CACHE_TTL_LONG_SECONDS,
	PROMPT_CACHE_TTL_SHORT_SECONDS,
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
		expect(resolvePromptCacheTtlSeconds(cacheableBedrockModel, env)).toBe(3600);
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
		expect(resolvePromptCacheTtlSeconds(anthropicModel)).toBe(3600);
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
	it("uses resolved OpenRouter compat for anthropic-prefixed models", () => {
		const openRouterModel = createModel("openai-completions", {
			id: "anthropic/claude-sonnet-4",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			cacheRetention: "long",
		});

		expect(getOpenAICompletionsCompat(openRouterModel).cacheControlFormat).toBe("anthropic");
		expect(resolvePromptCacheTtlSeconds(openRouterModel)).toBe(3600);
	});

	it("selects Moonshot tool schema normalization automatically", () => {
		const moonshotModel = createModel("openai-completions", {
			provider: "moonshotai",
			baseUrl: "https://api.moonshot.ai/v1",
		});

		expect(getOpenAICompletionsCompat(moonshotModel).toolSchemaFlavor).toBe("moonshot-mfjs");
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

	it("returns one hour for a cacheable Claude model with long retention", () => {
		expect(resolvePromptCacheTtlSeconds({ ...cacheableBedrockModel, cacheRetention: "long" })).toBe(3600);
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
		expect(resolvePromptCacheTtlSeconds(model, env)).toBe(3600);
	});
});

describe("automatic and unknown cache backends", () => {
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
		},
	);
});
