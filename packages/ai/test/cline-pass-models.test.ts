import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";
import { findEnvKeys } from "../src/env-api-keys.ts";
import { builtinProviders } from "../src/providers/all.ts";

describe("ClinePass provider registration", () => {
	it("registers cline-pass among the builtin providers", () => {
		const ids = builtinProviders().map((provider) => provider.id);
		expect(ids).toContain("cline-pass");
	});
});

describe("ClinePass credentials", () => {
	it("reads the API key from CLINE_API_KEY", () => {
		expect(findEnvKeys("cline-pass", { CLINE_API_KEY: "sk-test" })).toEqual(["CLINE_API_KEY"]);
	});

	it("does not accept another provider's API key variable", () => {
		expect(findEnvKeys("cline-pass", { OPENAI_API_KEY: "sk-test" })).toBeUndefined();
	});
});

describe("ClinePass models", () => {
	it("resolves the default ClinePass model", () => {
		const model = getModel("cline-pass", "cline-pass/kimi-k3");
		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.cline.bot/api/v1");
		expect(model.reasoning).toBe(true);
	});

	it("covers the model families ClinePass serves", () => {
		const modelIds = getModels("cline-pass").map((model) => model.id);
		for (const id of [
			"cline-pass/qwen3.7-plus",
			"cline-pass/qwen3.7-max",
			"cline-pass/glm-5.2",
			"cline-pass/deepseek-v4-pro",
			"cline-pass/kimi-k3",
		]) {
			expect(modelIds).toContain(id);
		}
	});

	it("keeps every model on the OpenAI-compatible ClinePass endpoint", () => {
		const models = getModels("cline-pass");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.provider).toBe("cline-pass");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.cline.bot/api/v1");
		}
	});
});
