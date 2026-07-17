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

function hasGrok45CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	// Keep in sync with presets.ts hasGrok45Signal — colon provider sep + compact grok45.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?5(?:$|[/@._:-])/.test(searchable);
}

function getGrok45CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasGrok45CatalogSignal));
}

describe("Grok 4.5 prompt preset", () => {
	it.each([
		"grok-4.5",
		"Grok 4.5",
		"xai/grok-4.5",
		"x-ai/grok-4.5",
		"xai:grok-4.5",
		"grok-4p5",
		"grok_4_5:thinking",
		"grok45",
		"Grok4.5",
		"grok-4.5-latest",
		"grok-4.5-thinking",
		"accounts/xai/models/grok-4.5",
	])("resolves %s to the grok-4.5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "xai", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("grok-4.5");
		expect(preset?.prompt).toContain("running on Grok 4.5");
		expect(preset?.prompt).toMatch(/Kimi-K2-descended model operating with Claude Fable 5 decisiveness and Claude Opus 4.6 depth/i);
		expect(preset?.prompt).toMatch(/read the request for its outcome, decide one path, and act/i);
		expect(preset?.prompt).toMatch(/when the direct path is blocked, route around/i);
		expect(preset?.prompt).toMatch(/exhaust alternatives before declaring a limit/i);
		expect(preset?.prompt).toMatch(/execute the obvious next step yourself/i);
		expect(preset?.prompt).toMatch(/done means the user's literal bar/i);
		expect(preset?.prompt).toMatch(/confirm behavior by running before claiming done/i);
		const tuning = preset?.prompt.slice(preset.prompt.indexOf("You are running on Grok 4.5")) ?? "";
		expect(tuning).not.toMatch(/\bLinaforge\b|\bANNO\b|ouroforge|sprite-gen|animation-driven mechanics/i);
		expect(preset?.prompt).not.toContain("apply_patch");
	});

	it.each([
		"grok-4.3",
		"grok-4.20-0309-reasoning",
		"grok-3",
		"grok-code-fast-1",
		"some-grok-compatible-router",
	])("does not route %s to the grok-4.5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "xai", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset).toBeUndefined();
	});

	it("allows settings.json to force grok-4.5 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "grok-4.5" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("grok-4.5");
		expect(preset?.prompt).toContain("running on Grok 4.5");
	});

	it("returns grok-4.5 preset for every Grok 4.5 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getGrok45CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "grok-4.5")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"xai/grok-4.5",
				"opencode/grok-4.5",
				"openrouter/x-ai/grok-4.5",
				"vercel-ai-gateway/xai/grok-4.5",
			]),
		);
		expect(misses).toEqual([]);
	});
});
