import { readFileSync } from "node:fs";
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
		// CEO / orchestrator role signals (full corePrompt rewrite, like gpt-5.6).
		expect(preset?.prompt).toMatch(/acting as CEO and orchestrator/i);
		expect(preset?.prompt).toMatch(/single human-facing surface/i);
		expect(preset?.prompt).toMatch(/delegate implementation via `bash`/i);
		expect(preset?.prompt).toMatch(/senpi --print/i);
		// CEO passes the Hephaestus prompt guide (the gpt-5.6/gpt-5.5 presets) to
		// workers by spawning them with --model gpt-5.6*, not by restating the
		// doctrine in the CEO prompt itself.
		expect(preset?.prompt).toMatch(/--model gpt-5\.6/i);
		expect(preset?.prompt).toMatch(/Hephaestus prompt guide/i);
		expect(preset?.prompt).toMatch(/consult oracle before deploying non-trivial work/i);
		expect(preset?.prompt).toMatch(/review invocation/i);
		expect(preset?.prompt).toMatch(/you are the human surface/i);
		expect(preset?.prompt).toMatch(/stop goal/i);
		expect(preset?.prompt).toMatch(/stopping is mandatory and immediate/i);
		// Shared sections are reused, not duplicated.
		expect(preset?.prompt).toContain("apply_patch");
		expect(preset?.prompt).toContain("### Test Discipline");
		// Routing-line discipline preserved.
		expect(preset?.prompt).toMatch(/i read this as \[intent\] - \[plan\]/i);
		// The full corePrompt is substantially larger than the old tuningSection.
		expect(preset?.prompt.length).toBeGreaterThan(3000);
		// Must NOT name a nonexistent task/subagent tool (senpi has no such tool).
		expect(preset?.prompt).not.toMatch(/`task` child|category: "deep"|category: "ultrabrain"|run_in_background/i);
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
		expect(preset?.prompt).toMatch(/acting as CEO and orchestrator/i);
		expect(preset?.prompt).toMatch(/delegate implementation via `bash`/i);
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

	it("does not invent Grok preset edition numbers while unreleased", () => {
		// given — Grok 4.5 has never been formally merged; fake v1/v2/… theater is noise
		const changesPath = new URL("../../src/core/extensions/builtin/prompt-preset/changes.md", import.meta.url);
		const changes = readFileSync(changesPath, "utf8");

		// then
		expect(changes).toMatch(/Grok 4\.5 preset \(unreleased/);
		expect(changes).not.toMatch(/Grok 4\.5 preset v\d+/);
	});
});
