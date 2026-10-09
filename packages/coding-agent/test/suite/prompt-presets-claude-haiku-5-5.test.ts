import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider: string, api: Api = "anthropic-messages"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

function hasHaiku55CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return searchable.includes("haiku-5-5") || searchable.includes("haiku-5.5");
}

function getHaiku55CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasHaiku55CatalogSignal));
}

describe("Claude Haiku 5.5 prompt preset", () => {
	it.each([
		"claude-haiku-5-5",
		"claude-haiku-5.5",
		"claude-haiku-5-5-20261007",
		"anthropic/claude-haiku-5-5",
		"anthropic/claude-haiku-5.5",
		"global.anthropic.claude-haiku-5-5",
		"us.anthropic.claude-haiku-5-5",
		"claude-haiku-5-5@default",
		"Claude Haiku 5.5",
	])("resolves %s to the claude-haiku-5-5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-haiku-5-5");
		expect(preset?.prompt).toContain("You are senpi");
	});

	it.each([
		"claude-haiku-4-5",
		"claude-haiku-4.5",
		"claude-haiku-4-5-20251001",
		"anthropic/claude-haiku-4-5",
		"claude-3-5-haiku",
	])("leaves %s on the default dynamic prompt", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const presetName = resolvePresetName(model, settings);

		// then
		expect(presetName).toBeUndefined();
	});

	it.each(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-55"])(
		"does not route %s to the claude-haiku-5-5 preset",
		(modelId) => {
			// given
			const settings: PromptPresetSettings = { promptPreset: "auto" };
			const model = createModel(modelId, "anthropic");

			// when
			const presetName = resolvePresetName(model, settings);

			// then
			expect(presetName).not.toBe("claude-haiku-5-5");
		},
	);

	it("allows settings.json to force claude-haiku-5-5 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "claude-haiku-5-5" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-haiku-5-5");
	});

	it("routes user questions through ask_user_question and carries no GPT tuning", () => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-haiku-5-5", "anthropic");

		const preset = resolvePreset(model, settings);

		expect(preset?.prompt).toContain("ask_user_question");
		expect(preset?.prompt).not.toContain("apply_patch");
	});

	it("returns claude-haiku-5-5 preset for every Claude Haiku 5.5 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getHaiku55CatalogModels();
		expect(catalogModels.length).toBeGreaterThan(0);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "claude-haiku-5-5")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(misses).toEqual([]);
	});

	it("names the Haiku early stop instead of the three Sonnet stops", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-haiku-5-5", "anthropic");

		// when
		const prompt = resolvePreset(model, settings)?.prompt ?? "";

		// then
		expect(prompt).toContain("handing the task back to the user is a defect");
		expect(prompt).not.toContain("three endings are defects");
	});

	it("adds the search-grounding sentence only when web_search is active", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-haiku-5-5", "anthropic");

		// when
		const withSearch = resolvePreset(model, settings, { selectedTools: ["read", "web_search"] })?.prompt ?? "";
		const withoutSearch = resolvePreset(model, settings, { selectedTools: ["read"] })?.prompt ?? "";

		// then
		expect(withSearch).toContain("your training data ends well before it");
		expect(withoutSearch).not.toContain("your training data ends well before it");
		expect(withSearch).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});
});
