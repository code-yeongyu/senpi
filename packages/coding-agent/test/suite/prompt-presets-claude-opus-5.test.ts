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

function hasOpus5CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return searchable.includes("opus-5");
}

function getOpus5CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasOpus5CatalogSignal));
}

describe("Claude Opus 5 prompt preset", () => {
	it.each([
		"claude-opus-5",
		"claude-opus-5-20260701",
		"anthropic/claude-opus-5",
		"us.anthropic.claude-opus-5-v1",
		"global.anthropic.claude-opus-5",
		"Claude Opus 5",
	])("resolves %s to the claude-opus-5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-opus-5");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("I'll stop when [the exact, observable condition that ends this turn]");
		expect(preset?.prompt).toContain("a defect, not diligence");
		expect(preset?.prompt).toContain("narrowing, widening, or transforming");
		expect(preset?.prompt).toContain("auto-compacts context");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each([
		"claude-opus-4-5",
		"claude-opus-4.5",
		"claude-opus-4-8",
		"claude-fable-5",
		"some-opus-compatible-router",
	])("does not route %s to the claude-opus-5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const presetName = resolvePresetName(model, settings);

		// then
		expect(presetName).not.toBe("claude-opus-5");
	});

	it.each([
		"claude-opus-4-5",
		"claude-opus-4-6",
		"claude-opus-4-7",
		"claude-opus-4-8",
		"claude-fable-5",
	])("keeps %s on its own preset after adding claude-opus-5", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const presetName = resolvePresetName(model, settings);

		// then
		expect(presetName).toBe(modelId);
	});

	it("does not route claude-opus-5 to any 4.x preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-opus-5", "anthropic");

		// when
		const presetName = resolvePresetName(model, settings);

		// then
		expect(presetName).toBe("claude-opus-5");
	});

	it("allows settings.json to force claude-opus-5 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "claude-opus-5" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-opus-5");
		expect(preset?.prompt).toContain("a defect, not diligence");
	});

	it("does not include GPT or Kimi tuning in the claude-opus-5 preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-opus-5", "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-opus-5");
		expect(preset?.prompt).not.toContain("apply_patch");
		expect(preset?.prompt).not.toContain("filler verification language");
	});

	it("does not carry the 4.7/4.8 scope-literalism or house-style tuning", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-opus-5", "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.prompt).not.toContain('"every", "all", and "each" mean the full set');
		expect(preset?.prompt).not.toContain("cream/serif/terracotta");
	});

	it("returns claude-opus-5 preset for every Claude Opus 5 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getOpus5CatalogModels();

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "claude-opus-5")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(misses).toEqual([]);
	});
});
