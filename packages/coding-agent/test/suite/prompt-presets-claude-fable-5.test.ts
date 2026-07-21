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

function hasFable5CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return /(?:^|[/@._-])claude-fable-5(?:$|[/@._:-])/.test(searchable);
}

function getFable5CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasFable5CatalogSignal));
}

describe("Claude Fable 5 prompt preset", () => {
	it.each([
		"claude-fable-5",
		"anthropic/claude-fable-5",
		"us.anthropic.claude-fable-5",
		"eu.anthropic.claude-fable-5",
		"global.anthropic.claude-fable-5",
		"Claude Fable 5",
	])("resolves %s to the claude-fable-5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-fable-5");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("a recommendation, not a survey");
		expect(preset?.prompt).toContain("audit each claim against a tool result");
		expect(preset?.prompt).toContain("on account of context limits");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each([
		"claude-opus-4-8",
		"~anthropic/claude-fable-latest",
		"some-fable-compatible-router",
	])("does not route %s to the claude-fable-5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const presetName = resolvePresetName(model, settings);

		// then
		expect(presetName).not.toBe("claude-fable-5");
	});

	it("allows settings.json to force claude-fable-5 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "claude-fable-5" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-fable-5");
		expect(preset?.prompt).toContain("audit each claim against a tool result");
	});

	it("does not include GPT or Kimi tuning in the claude-fable-5 preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-fable-5", "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-fable-5");
		expect(preset?.prompt).not.toContain("apply_patch");
		expect(preset?.prompt).not.toContain("filler verification language");
	});

	it("returns claude-fable-5 preset for every Claude Fable 5 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getFable5CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "claude-fable-5")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"anthropic/claude-fable-5",
				"github-copilot/claude-fable-5",
				"openrouter/anthropic/claude-fable-5",
				"amazon-bedrock/global.anthropic.claude-fable-5",
				"vercel-ai-gateway/anthropic/claude-fable-5",
			]),
		);
		expect(misses).toEqual([]);
	});
});
