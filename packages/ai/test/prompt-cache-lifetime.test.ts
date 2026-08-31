import { describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import {
	PROMPT_CACHE_TTL_SHORT_SECONDS,
	resolvePromptCacheLifetime,
	resolvePromptCacheTtlSeconds,
} from "../src/utils/prompt-cache-ttl.ts";

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

describe("prompt-cache lifetime classification", () => {
	it("classifies direct DeepSeek as automatic", () => {
		const model = createModel("openai-completions", {
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
		});

		expect(resolvePromptCacheLifetime(model)).toEqual({ kind: "automatic" });
		expect(resolvePromptCacheTtlSeconds(model)).toBeUndefined();
	});

	it("detects mixed-case canonical DeepSeek hosts without matching spoofed authorities", () => {
		const uppercase = createModel("openai-completions", {
			provider: "custom-proxy",
			baseUrl: "https://API.DEEPSEEK.COM/v1",
		});
		const spoofed = createModel("openai-completions", {
			provider: "custom-proxy",
			baseUrl: "https://deepseek.com.example.org/v1",
		});
		const malformed = createModel("openai-completions", {
			provider: "custom-proxy",
			baseUrl: "not a URL",
		});

		expect(resolvePromptCacheLifetime(uppercase)).toEqual({ kind: "automatic" });
		for (const model of [spoofed, malformed]) {
			expect(resolvePromptCacheLifetime(model)).toEqual({
				kind: "fixed",
				ttlSeconds: PROMPT_CACHE_TTL_SHORT_SECONDS,
			});
		}
	});

	it("lets explicit disabled retention override DeepSeek automatic caching", () => {
		const model = createModel("openai-completions", {
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			cacheRetention: "none",
		});

		expect(resolvePromptCacheLifetime(model)).toEqual({ kind: "disabled" });
		expect(resolvePromptCacheTtlSeconds(model)).toBeUndefined();
	});

	it("keeps long DeepSeek retention automatic without fabricating a TTL", () => {
		const model = createModel("openai-completions", {
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			cacheRetention: "long",
		});

		expect(resolvePromptCacheLifetime(model)).toEqual({ kind: "automatic" });
		expect(resolvePromptCacheTtlSeconds(model)).toBeUndefined();
	});

	it("preserves conservative behavior for unrelated OpenAI-compatible providers", () => {
		const model = createModel("openai-completions", {
			provider: "custom-proxy",
			baseUrl: "https://proxy.example.org/v1",
		});

		expect(resolvePromptCacheLifetime(model)).toEqual({
			kind: "fixed",
			ttlSeconds: PROMPT_CACHE_TTL_SHORT_SECONDS,
		});
		expect(resolvePromptCacheTtlSeconds(model)).toBe(PROMPT_CACHE_TTL_SHORT_SECONDS);
	});

	it("preserves fixed and unknown lanes", () => {
		expect(
			resolvePromptCacheLifetime(
				createModel("anthropic-messages", {
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com/v1",
				}),
			),
		).toEqual({ kind: "fixed", ttlSeconds: PROMPT_CACHE_TTL_SHORT_SECONDS });
		expect(resolvePromptCacheLifetime(createModel("google-generative-ai"))).toEqual({ kind: "unknown" });
	});
});
