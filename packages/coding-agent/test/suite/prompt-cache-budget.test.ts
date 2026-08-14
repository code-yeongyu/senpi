import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROMPT_CACHE_SAFETY_BUFFER_SECONDS,
	resolvePromptCacheSafeWaitSeconds,
} from "../../src/core/prompt-cache-budget.ts";

function anthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	} as Model<"anthropic-messages">;
}

function deepseekModel(): Model<"openai-completions"> {
	return {
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<"openai-completions">;
}

function googleModel(): Model<"google-generative-ai"> {
	return {
		id: "gemini-3-pro",
		name: "Gemini 3 Pro",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 8192,
	} as Model<"google-generative-ai">;
}

describe("resolvePromptCacheSafeWaitSeconds", () => {
	it("subtracts the default 30s safety buffer from a 5m TTL", () => {
		expect(resolvePromptCacheSafeWaitSeconds(anthropicModel(), undefined, {})).toBe(270);
		expect(DEFAULT_PROMPT_CACHE_SAFETY_BUFFER_SECONDS).toBe(30);
	});

	it("subtracts the buffer from a 1h TTL for direct api.anthropic.com models", () => {
		const model = anthropicModel({ baseUrl: "https://api.anthropic.com", cacheRetention: "long" });
		expect(resolvePromptCacheSafeWaitSeconds(model, undefined, {})).toBe(3570);
	});

	it("honors a configured safetyBufferSeconds", () => {
		expect(resolvePromptCacheSafeWaitSeconds(anthropicModel(), { safetyBufferSeconds: 295 }, {})).toBe(5);
	});

	it("returns undefined when the feature is disabled", () => {
		expect(resolvePromptCacheSafeWaitSeconds(anthropicModel(), { cacheAwareTimeouts: false }, {})).toBeUndefined();
	});

	it("returns undefined when the model TTL is unknown", () => {
		expect(resolvePromptCacheSafeWaitSeconds(googleModel() as Model<Api>, undefined, {})).toBeUndefined();
	});

	it("returns undefined for automatic-cache providers like direct DeepSeek", () => {
		expect(resolvePromptCacheSafeWaitSeconds(deepseekModel(), undefined, {})).toBeUndefined();
	});

	it("returns undefined when no model is active", () => {
		expect(resolvePromptCacheSafeWaitSeconds(undefined, undefined, {})).toBeUndefined();
	});

	it("returns undefined when the buffer swallows the whole TTL", () => {
		expect(resolvePromptCacheSafeWaitSeconds(anthropicModel(), { safetyBufferSeconds: 300 }, {})).toBeUndefined();
		expect(resolvePromptCacheSafeWaitSeconds(anthropicModel(), { safetyBufferSeconds: 400 }, {})).toBeUndefined();
	});

	it("ignores a negative or non-finite buffer and falls back to the default", () => {
		expect(resolvePromptCacheSafeWaitSeconds(anthropicModel(), { safetyBufferSeconds: -5 }, {})).toBe(270);
		expect(resolvePromptCacheSafeWaitSeconds(anthropicModel(), { safetyBufferSeconds: Number.NaN }, {})).toBe(270);
	});

	it("passes provider env through to the TTL resolver", () => {
		const model = anthropicModel({ baseUrl: "https://api.anthropic.com" });
		expect(resolvePromptCacheSafeWaitSeconds(model, undefined, { PI_CACHE_RETENTION: "long" })).toBe(3570);
	});

	it("filters undefined env values at the boundary", () => {
		const env: NodeJS.ProcessEnv = { PI_CACHE_RETENTION: undefined, PATH: "/usr/bin" };
		expect(resolvePromptCacheSafeWaitSeconds(anthropicModel(), undefined, env)).toBe(270);
	});
});
