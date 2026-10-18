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

function hasSonnet55CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return searchable.includes("sonnet-5-5") || searchable.includes("sonnet-5.5");
}

function getSonnet55CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasSonnet55CatalogSignal));
}

describe("Claude Sonnet 5.5 prompt preset", () => {
	it.each([
		"claude-sonnet-5-5",
		"claude-sonnet-5.5",
		"claude-sonnet-5-5-20260928",
		"anthropic/claude-sonnet-5-5",
		"anthropic/claude-sonnet-5.5",
		"global.anthropic.claude-sonnet-5-5",
		"us.anthropic.claude-sonnet-5-5",
		"claude-sonnet-5-5@default",
		"Claude Sonnet 5.5",
	])("resolves %s to the claude-sonnet-5-5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-sonnet-5-5");
		expect(preset?.prompt).toContain("You are senpi");
	});

	it.each(["claude-sonnet-5", "claude-sonnet-5-20260629", "anthropic/claude-sonnet-5", "claude-sonnet-4-6"])(
		"leaves %s on the default dynamic prompt",
		(modelId) => {
			// given
			const settings: PromptPresetSettings = { promptPreset: "auto" };
			const model = createModel(modelId, "anthropic");

			// when
			const presetName = resolvePresetName(model, settings);

			// then
			expect(presetName).toBeUndefined();
		},
	);

	it.each(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-55"])(
		"does not route %s to the claude-sonnet-5-5 preset",
		(modelId) => {
			// given
			const settings: PromptPresetSettings = { promptPreset: "auto" };
			const model = createModel(modelId, "anthropic");

			// when
			const presetName = resolvePresetName(model, settings);

			// then
			expect(presetName).not.toBe("claude-sonnet-5-5");
		},
	);

	it("allows settings.json to force claude-sonnet-5-5 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "claude-sonnet-5-5" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-sonnet-5-5");
	});

	it("routes user questions through ask_user_question and carries no GPT tuning", () => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-sonnet-5-5", "anthropic");

		const preset = resolvePreset(model, settings);

		expect(preset?.prompt).toContain("ask_user_question");
		expect(preset?.prompt).not.toContain("apply_patch");
	});

	it("returns claude-sonnet-5-5 preset for every Claude Sonnet 5.5 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getSonnet55CatalogModels();
		expect(catalogModels.length).toBeGreaterThan(0);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "claude-sonnet-5-5")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(misses).toEqual([]);
	});
});
