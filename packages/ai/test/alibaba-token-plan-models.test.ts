import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";

describe("Alibaba Token Plan models", () => {
	it("resolves the flagship text model", () => {
		const model = getModel("alibaba-token-plan", "qwen3.7-max");
		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
		expect(model.reasoning).toBe(true);
	});

	it("covers every text model family in the token plan", () => {
		const modelIds = getModels("alibaba-token-plan").map((model) => model.id);
		for (const id of ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash", "glm-5.2", "deepseek-v4-pro"]) {
			expect(modelIds).toContain(id);
		}
	});

	it("omits image-generation models without tool calling", () => {
		const modelIds = getModels("alibaba-token-plan").map((model) => model.id);
		expect(modelIds).not.toContain("wan2.7-image");
		expect(modelIds).not.toContain("wan2.7-image-pro");
	});
});
