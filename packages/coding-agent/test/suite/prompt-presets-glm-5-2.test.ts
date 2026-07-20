import { type Api, getModels, getProviders, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
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

function hasGlm52CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return /(?:^|[/@._-])glm(?:[._-]|p)5(?:[._-]|p)2(?:$|[/@._:-])/.test(searchable);
}

function getGlm52CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasGlm52CatalogSignal));
}

describe("GLM 5.2 prompt preset", () => {
	it.each([
		"zai-org/glm-5.2",
		"glm-5.2",
		"GLM 5.2",
		"zai-org/glm-5p2",
		"zai-org/glm_5_2:thinking",
	])("resolves %s to the glm-5.2 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("glm-5.2");
		expect(preset?.prompt).toContain("running on GLM 5.2");
		expect(preset?.prompt).toContain("absolute certainty");
		expect(preset?.prompt).toContain("todo");
		expect(preset?.prompt).not.toContain("apply_patch");
	});

	it.each([
		"glm-4.6",
		"zai-org/glm-4.5",
		"some-glm-compatible-router",
	])("does not route %s to the glm-5.2 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset).toBeUndefined();
	});

	it("allows settings.json to force glm-5.2 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "glm-5.2" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("glm-5.2");
		expect(preset?.prompt).toContain("running on GLM 5.2");
	});

	it("returns glm-5.2 preset for every GLM 5.2 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getGlm52CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "glm-5.2")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"cloudflare-workers-ai/@cf/zai-org/glm-5.2",
				"fireworks/accounts/fireworks/models/glm-5p2",
				"openrouter/z-ai/glm-5.2",
				"zai/glm-5.2",
			]),
		);
		expect(misses).toEqual([]);
	});
});
