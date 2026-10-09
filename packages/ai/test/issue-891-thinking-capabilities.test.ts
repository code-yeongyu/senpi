import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { getBuiltinModel, getBuiltinModels } from "../src/providers/all.ts";

const TOGGLE_ONLY_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	xhigh: null,
	max: null,
} as const;

describe("issue #891 generated thinking capabilities", () => {
	it.each([getBuiltinModel("zai", "glm-4.7"), getBuiltinModel("qwen-token-plan", "qwen3.6-flash")])(
		"limits $provider/$id to on or off",
		(model) => {
			expect(model.thinkingLevelMap, `${model.provider}/${model.id}`).toEqual(TOGGLE_ONLY_THINKING_LEVEL_MAP);
			expect(getSupportedThinkingLevels(model), `${model.provider}/${model.id}`).toEqual(["off", "high"]);
		},
	);

	it("keeps GLM-4.7's thinking-off control selectable", () => {
		const model = getBuiltinModels("zai").find((candidate) => candidate.id === "glm-4.7");

		expect(model).toBeDefined();
		if (!model) throw new Error("Missing zai/glm-4.7");
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
	});

	it("does not change Xiaomi's existing disabled-thinking transport contract", () => {
		const model = getBuiltinModel("xiaomi", "mimo-v2.5");

		expect(model.thinkingLevelMap).toBeUndefined();
		expect(model.compat).toMatchObject({ supportsDisabledThinking: false, thinkingFormat: "deepseek" });
	});

	it.each(["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"] as const)(
		"keeps the explicit Qwen3.8 map and preview exclusion for %s",
		(provider) => {
			const models = getBuiltinModels(provider);
			const model = models.find((candidate) => candidate.id === "qwen3.8-max");

			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing ${provider}/qwen3.8-max`);
			expect(model.thinkingLevelMap?.off).toBeNull();
			expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "xhigh"]);
			expect(models.map((candidate) => candidate.id)).not.toContain("qwen3.8-max-preview");
		},
	);
});
