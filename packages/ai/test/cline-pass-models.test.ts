import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";

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
