import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider: string, api: Api = "openai-completions"): Model<Api> {
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

function hasGrok46CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	// Keep in sync with presets.ts hasGrok46Signal — colon provider sep + compact grok46.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?6(?:$|[/@._:-])/.test(searchable);
}

function getGrok46CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasGrok46CatalogSignal));
}

describe("Grok 4.6 prompt preset", () => {
	it.each([
		"grok-4.6",
		"Grok 4.6",
		"xai/grok-4.6",
		"x-ai/grok-4.6",
		"xai:grok-4.6",
		"grok-4p6",
		"grok_4_6:thinking",
		"grok46",
		"Grok4.6",
		"grok-4.6-latest",
		"grok-4.6-thinking",
		"accounts/xai/models/grok-4.6",
	])("resolves %s to the grok-4.6 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "xai", "openai-completions");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("grok-4.6");
		// Direct-implementer full-core rewrite (not the 4.5 CEO/orchestrator posture).
		expect(preset?.prompt).toContain("Grok 4.6");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("I read this as");
		// Shared sections are reused, not duplicated.
		expect(preset?.prompt).toContain("### Test Discipline");
		expect(preset?.prompt).toContain("## Verification");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
		// apply_patch is gated to gpt-* ids; the Grok 4.6 preset must not name it.
		expect(preset?.prompt).not.toContain("apply_patch");
		// Must NOT inherit the 4.5 CEO delegation posture.
		expect(preset?.prompt).not.toContain("CEO");
	});

	it.each(["grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-3", "grok-build-0.1", "grok-4.60"])(
		"does not route %s to the grok-4.6 preset",
		(modelId) => {
			// given
			const settings: PromptPresetSettings = { promptPreset: "auto" };
			const model = createModel(modelId, "xai", "openai-completions");

			// when
			const preset = resolvePreset(model, settings);

			// then
			expect(preset?.name === "grok-4.6").toBe(false);
		},
	);

	it("keeps grok-4.5 on its own preset, distinct from grok-4.6", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };

		// when
		const grok45 = resolvePreset(createModel("grok-4.5", "xai", "openai-responses"), settings);
		const grok46 = resolvePreset(createModel("grok-4.6", "xai", "openai-completions"), settings);

		// then
		expect(grok45?.name).toBe("grok-4.5");
		expect(grok46?.name).toBe("grok-4.6");
		expect(grok46?.prompt).not.toBe(grok45?.prompt);
	});

	it("allows settings.json to force grok-4.6 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "grok-4.6" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("grok-4.6");
	});

	it("returns grok-4.6 preset for every Grok 4.6 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getGrok46CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "grok-4.6")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"xai/grok-4.6",
				"opencode/grok-4.6",
				"openrouter/x-ai/grok-4.6",
				"vercel-ai-gateway/xai/grok-4.6",
			]),
		);
		expect(misses).toEqual([]);
	});
});
