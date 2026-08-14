import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Api, type Model, resolvePromptCacheLifetime, resolvePromptCacheTtlSeconds } from "../src/index.ts";

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

const deepseekModel = createModel("openai-completions", {
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
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

describe("DeepSeek automatic cache lifetime (issue #831)", () => {
	it("classifies direct DeepSeek as automatic, not a fixed 5m TTL", () => {
		expect(resolvePromptCacheLifetime(deepseekModel)).toEqual({ kind: "automatic" });
	});

	it("detects DeepSeek through a deepseek.com base URL", () => {
		const urlModel = createModel("openai-completions", {
			provider: "custom-proxy",
			baseUrl: "https://api.deepseek.com/v1",
		});
		expect(resolvePromptCacheLifetime(urlModel)).toEqual({ kind: "automatic" });
	});

	it("reports no fixed TTL for direct DeepSeek via the legacy wrapper", () => {
		expect(resolvePromptCacheTtlSeconds(deepseekModel)).toBeUndefined();
	});

	it("keeps long retention from fabricating a fixed TTL for DeepSeek", () => {
		expect(resolvePromptCacheLifetime(deepseekModel, { PI_CACHE_RETENTION: "long" })).toEqual({
			kind: "automatic",
		});
		expect(resolvePromptCacheTtlSeconds(deepseekModel, { PI_CACHE_RETENTION: "long" })).toBeUndefined();
	});
});

describe("prompt-cache lifetime classification", () => {
	it("maps every other lane exactly as the legacy TTL resolver did", () => {
		expect(resolvePromptCacheLifetime(anthropicModel)).toEqual({ kind: "fixed", ttlSeconds: 300 });
		expect(resolvePromptCacheLifetime({ ...anthropicModel, cacheRetention: "long" })).toEqual({
			kind: "fixed",
			ttlSeconds: 3600,
		});
		expect(resolvePromptCacheLifetime({ ...anthropicModel, cacheRetention: "none" })).toEqual({ kind: "disabled" });
		expect(resolvePromptCacheLifetime(anthropicCompletionsModel)).toEqual({ kind: "fixed", ttlSeconds: 300 });
		expect(resolvePromptCacheLifetime(cacheableBedrockModel)).toEqual({ kind: "fixed", ttlSeconds: 300 });
		expect(resolvePromptCacheLifetime(openAIResponsesModel)).toEqual({ kind: "fixed", ttlSeconds: 300 });
		expect(resolvePromptCacheLifetime(createModel("openai-completions", { cacheRetention: "none" }))).toEqual({
			kind: "disabled",
		});
		expect(resolvePromptCacheLifetime(createModel("google-generative-ai"))).toEqual({ kind: "unknown" });
	});

	it("keeps the legacy wrapper identical to the fixed lifetime", () => {
		const lifetime = resolvePromptCacheLifetime(anthropicModel);
		expect(resolvePromptCacheTtlSeconds(anthropicModel)).toBe(
			lifetime.kind === "fixed" ? lifetime.ttlSeconds : undefined,
		);
	});
});
