import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { GLM5_TUNING } from "../../src/core/extensions/builtin/prompt-preset/glm-5.ts";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider: string, api: Api = "openai-responses"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function hasGlm53CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return /(?:^|[/@._-])glm(?:[._-]|p)5(?:[._-]|p)3(?:$|[/@._:-])/.test(searchable);
}

function getGlm53CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasGlm53CatalogSignal));
}

describe("GLM 5.3 prompt preset", () => {
	it.each([
		"glm-5.3",
		"zai-org/GLM-5.3",
		"z-ai/glm-5.3",
		"zai/glm-5.3",
		"@cf/zai-org/glm-5.3",
		"workers-ai/@cf/zai-org/glm-5.3",
		"accounts/fireworks/models/glm-5p3",
		"glm-5.3-highspeed",
		"zai-org/glm_5_3:thinking",
		"GLM 5.3",
	])("resolves %s to the glm-5.3 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("glm-5.3");
		expect(preset?.prompt).toContain(GLM5_TUNING);
		expect(preset?.prompt).not.toContain("apply_patch");
	});

	it.each(["glm-5.2", "glm-4.6", "zai-org/glm-4.5", "some-glm-compatible-router"])(
		"does not route %s to the glm-5.3 preset",
		(modelId) => {
			// given
			const settings: PromptPresetSettings = { promptPreset: "auto" };
			const model = createModel(modelId, "openrouter", "openai-responses");

			// when
			const name = resolvePresetName(model, settings);

			// then
			expect(name === undefined || name !== "glm-5.3").toBe(true);
		},
	);

	it("allows settings.json to force glm-5.3 regardless of model id", () => {
		// given
		const settings = { promptPreset: "glm-5.3" } as PromptPresetSettings;
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("glm-5.3");
		expect(preset?.prompt).toContain(GLM5_TUNING);
	});

	it("returns glm-5.3 preset for every GLM 5.3 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getGlm53CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "glm-5.3")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(expect.arrayContaining(["zai/glm-5.3", "zai-coding-cn/glm-5.3"]));
		expect(misses).toEqual([]);
	});
});
