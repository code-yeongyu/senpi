import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";

describe("Neuralwatt models", () => {
	it("resolves the flex reasoning model", () => {
		const model = getModel("neuralwatt", "glm-5.2-flex");
		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.neuralwatt.com/v1");
		expect(model.reasoning).toBe(true);
	});

	it("covers every model family Neuralwatt serves", () => {
		const modelIds = getModels("neuralwatt").map((model) => model.id);
		for (const id of [
			"Qwen/Qwen3.5-397B-A17B-FP8",
			"Qwen/Qwen3.6-35B-A3B",
			"deepseek-v4-flash",
			"gemma-4-31b",
			"glm-5.2",
			"glm-5.2-fast",
			"glm-5.2-flex",
			"glm-5.2-short",
			"glm-5.2-short-fast",
			"glm-5.2-short-fast-flex",
			"glm-5.2-short-flex",
			"kimi-k2.5-fast",
			"kimi-k2.6-fast",
			"kimi-k2.6-flex",
			"kimi-k2.7-code-flex",
			"kimi-k3",
			"kimi-k3-fast",
			"moonshotai/Kimi-K2.5",
			"moonshotai/Kimi-K2.6",
			"moonshotai/Kimi-K2.7-Code",
			"qwen3.5-397b-fast",
			"qwen3.6-35b-fast",
		]) {
			expect(modelIds).toContain(id);
		}
		expect(modelIds).toHaveLength(22);
	});

	it("omits models from other providers", () => {
		const modelIds = getModels("neuralwatt").map((model) => model.id);
		expect(modelIds).not.toContain("gpt-4o");
	});
});
