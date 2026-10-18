import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { BuildDynamicSystemPromptOptions } from "../../src/core/dynamic-prompt/build.ts";
import { buildGrok47Prompt } from "../../src/core/extensions/builtin/prompt-preset/grok-4.7.ts";
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

function hasGrok47CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	// Keep in sync with presets.ts hasGrok47Signal — colon provider sep, compact grok47, and
	// venice's dashed grok-4-7 all count.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?7(?:$|[/@._:-])/.test(searchable);
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function getGrok47CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasGrok47CatalogSignal));
}

const sharedOptions: BuildDynamicSystemPromptOptions = {
	cwd: "/tmp/project",
	selectedTools: ["read", "edit"],
	toolSnippets: { read: "# read\nReads files." },
	promptGuidelines: ["Ship focused fixes."],
	contextFiles: [{ path: "AGENTS.md", content: "# project rules" }],
	skills: [],
};

describe("Grok 4.7 prompt preset", () => {
	it.each([
		"grok-4.7",
		"Grok 4.7",
		"xai/grok-4.7",
		"x-ai/grok-4.7",
		"xai:grok-4.7",
		"grok-4p7",
		"grok_4_7:thinking",
		"grok47",
		"Grok4.7",
		"grok-4.7-latest",
		"grok-4.7-thinking",
		"grok-4-7",
		"accounts/xai/models/grok-4.7",
	])("resolves %s to the grok-4.7 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "xai", "openai-completions");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("grok-4.7");
	});

	it.each(["grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-3", "grok-build-0.1", "grok-4.70"])(
		"does not route %s to the grok-4.7 preset",
		(modelId) => {
			// given
			const settings: PromptPresetSettings = { promptPreset: "auto" };
			const model = createModel(modelId, "xai", "openai-completions");

			// when
			const preset = resolvePreset(model, settings);

			// then
			expect(preset?.name === "grok-4.7").toBe(false);
		},
	);

	it("keeps grok-4.6 on its own preset, distinct from grok-4.7", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };

		// when
		const grok46 = resolvePreset(createModel("grok-4.6", "xai", "openai-responses"), settings);
		const grok47 = resolvePreset(createModel("grok-4.7", "xai", "openai-responses"), settings);

		// then
		expect(grok46?.name).toBe("grok-4.6");
		expect(grok47?.name).toBe("grok-4.7");
	});

	it("renders its own tuned core, self-identified as Grok 4.7", () => {
		// given
		const prompt = buildGrok47Prompt(sharedOptions);

		// then
		expect(prompt).toContain("running on Grok 4.7");
		expect(prompt).not.toContain("Grok 4.6");
		expect(occurrences(prompt, "## Handoff")).toBe(1);
		expect(prompt).toContain("## Intent Gate");
	});

	it("allows settings.json to force grok-4.7 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "grok-4.7" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("grok-4.7");
		expect(preset?.prompt).toContain("running on Grok 4.7");
	});

	it("returns grok-4.7 preset for every Grok 4.7 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getGrok47CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "grok-4.7")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"xai/grok-4.7",
				"github-copilot/grok-4.7",
				"opencode-go/grok-4.7",
				"openrouter/x-ai/grok-4.7",
				"vercel-ai-gateway/spacexai/grok-4.7",
				"venice/grok-4-7",
			]),
		);
		expect(misses).toEqual([]);
	});
});
