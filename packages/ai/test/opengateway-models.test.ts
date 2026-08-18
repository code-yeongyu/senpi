import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import { opengatewayProvider } from "../src/providers/opengateway.ts";

describe("OpenGateway provider", () => {
	it("builds a provider factory wired for OpenAI-compatible Chat Completions", () => {
		const provider = opengatewayProvider();
		expect(provider.id).toBe("opengateway");
		expect(provider.name).toBe("OpenGateway");
		expect(provider.baseUrl).toBe("https://apis.opengateway.ai/v1");
		expect(provider.auth.apiKey).toBeDefined();
	});

	it("registers gateway chat models via the OpenAI-compatible Chat Completions API", () => {
		const model = getModel("opengateway", "moonshotai/kimi-k3");
		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("opengateway");
		expect(model.baseUrl).toBe("https://apis.opengateway.ai/v1");
		expect(model.input).toEqual(["text", "image"]);
	});

	it("covers the major model families served by the gateway", () => {
		const modelIds = getModels("opengateway").map((model) => model.id);
		for (const id of [
			"openai/gpt-5",
			"anthropic/claude-fable-5",
			"google/gemini-2.5-pro",
			"moonshotai/kimi-k3",
			"z-ai/glm-5.2",
			"deepseek/deepseek-v4-pro",
			"qwen/qwen3.7-max",
			"minimax/MiniMax-M3",
			"x-ai/grok-4.3",
		]) {
			expect(modelIds).toContain(id);
		}
	});

	it("omits image-generation, embedding, and retired models", () => {
		const modelIds = getModels("opengateway").map((model) => model.id);
		expect(modelIds).not.toContain("openai/gpt-image-2");
		expect(modelIds).not.toContain("sionic-ai/comsat-embed-ko-8b-preview");
		expect(modelIds).not.toContain("openai/o1-preview");
	});

	it("enriches catalog entries with reasoning and cost metadata", () => {
		const o3 = getModel("opengateway", "openai/o3");
		expect(o3.reasoning).toBe(true);
		const gpt5 = getModel("opengateway", "openai/gpt-5");
		expect(gpt5.cost.input).toBeGreaterThan(0);
		expect(gpt5.contextWindow).toBeGreaterThan(0);
	});

	it("detects OPENGATEWAY_API_KEY from the environment", () => {
		expect(getEnvApiKey("opengateway", { OPENGATEWAY_API_KEY: "test-key" })).toBe("test-key");
	});
});
