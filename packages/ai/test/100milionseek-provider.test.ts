import { describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { oneHundredMilionseekProvider } from "../src/providers/100milionseek.ts";

describe("100milionseek provider", () => {
	it("builds an API-key provider on the OpenAI-compatible endpoint", () => {
		const provider = oneHundredMilionseekProvider();
		expect(provider.id).toBe("100milionseek");
		expect(provider.name).toBe("100milionseek");
		expect(provider.baseUrl).toBe("https://100milionseek.top/v1");
		expect(provider.auth.apiKey).toBeDefined();
	});

	it("ships the free model with its documented limits and compatibility", () => {
		expect(getBuiltinModel("100milionseek", "deepseek-v4.1-flash-free")).toMatchObject({
			api: "openai-completions",
			provider: "100milionseek",
			baseUrl: "https://100milionseek.top/v1",
			input: ["text"],
			contextWindow: 198000,
			maxTokens: 64000,
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
		});
	});

	it("detects 100MILIONSEEK_API_KEY from the environment", () => {
		expect(getEnvApiKey("100milionseek", { "100MILIONSEEK_API_KEY": "test-key" })).toBe("test-key");
	});
});
