import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getApplyPatchWireMode } from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider = "openai", api: Api = "openai-responses"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

const AUTO: PromptPresetSettings = { promptPreset: "auto" };

function hasGpt6SolOrLunaCatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	// Keep in sync with presets.ts hasGpt6FamilySignal: the optional point release covers gpt-6.1-sol
	// and Venice's dotless gpt-61-sol.
	return /(?:^|[/@:._-])gpt[._-]?6(?:[._-]\d+|\d)?[._-](?:sol|luna)(?:$|[/@:._-])/.test(searchable);
}

function getGpt6SolAndLunaCatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) =>
		(getModels(provider) as Model<Api>[]).filter(hasGpt6SolOrLunaCatalogSignal),
	);
}

// The OpenAI GPT-6 guide ships one set of prompting practices for Astra, 6.1 Sol, Sol and Luna
// (developers.openai.com/api/docs/guides/latest-model), so the whole family renders the
// gpt-6-astra preset. The preset name stays "gpt-6-astra" because settings.json already pins it.
describe("GPT-6 Sol / 6.1 Sol / Luna prompt preset", () => {
	it.each([
		{ id: "gpt-6-sol", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6.1-sol", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6.1-sol-fast", provider: "chatgpt-subscription", api: "openai-codex-responses" as const },
		{ id: "openai/gpt-6.1-sol", provider: "openrouter", api: "openai-completions" as const },
		{ id: "openai/gpt-6.1-sol-fast", provider: "vercel-ai-gateway", api: "anthropic-messages" as const },
		{ id: "openai-gpt-61-sol", provider: "venice", api: "openai-completions" as const },
		{ id: "GPT-6.1-Sol", provider: "custom", api: "openai-responses" as const },
		{ id: "gpt-6-luna", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6-sol-fast", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6-luna-fast", provider: "chatgpt-subscription", api: "openai-codex-responses" as const },
		{ id: "gpt-6-sol", provider: "chatgpt-subscription", api: "openai-codex-responses" as const },
		{ id: "gpt-6-sol-2026-09-23", provider: "openai", api: "openai-responses" as const },
		{ id: "openai/gpt-6-sol", provider: "openrouter", api: "openai-completions" as const },
		{ id: "openai/gpt-6-luna:batch", provider: "openrouter", api: "openai-completions" as const },
		{ id: "openai-gpt-6-luna", provider: "venice", api: "openai-completions" as const },
		{ id: "global.openai.gpt-6-sol", provider: "amazon-bedrock", api: "bedrock-converse-stream" as const },
		{ id: "GPT-6-Luna", provider: "custom", api: "openai-responses" as const },
		{ id: "gpt_6_sol", provider: "custom", api: "openai-completions" as const },
	])("resolves $provider/$id to the GPT-6 family preset", ({ id, provider, api }) => {
		// given
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, AUTO);

		// then
		expect(preset?.name).toBe("gpt-6-astra");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("## Initiative");
	});

	it.each(["GPT-6 Sol", "GPT-6.1 Sol", "GPT-6 Luna"])(
		"resolves the display name %s when the id carries no family",
		(name) => {
			// given
			const model: Model<Api> = { ...createModel("default-model", "custom"), name };

			// when
			const presetName = resolvePresetName(model, AUTO);

			// then
			expect(presetName).toBe("gpt-6-astra");
		},
	);

	it("renders the same prompt for Sol, 6.1 Sol and Luna as for Astra", () => {
		// given
		const options = {
			cwd: "/repo",
			selectedTools: ["eval", "read", "bash", "monitor", "task", "todo", "apply_patch"],
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		};

		// when
		const astra = resolvePreset(createModel("gpt-6-astra"), AUTO, options);
		const sol = resolvePreset(createModel("gpt-6-sol"), AUTO, options);
		const sixOneSol = resolvePreset(createModel("gpt-6.1-sol"), AUTO, options);
		const luna = resolvePreset(createModel("gpt-6-luna"), AUTO, options);

		// then
		expect(sol?.prompt).toBe(astra?.prompt);
		expect(sixOneSol?.prompt).toBe(astra?.prompt);
		expect(luna?.prompt).toBe(astra?.prompt);
		expect(sol?.prompt).not.toMatch(/\bAstra\b/);
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-luna-fast", "openai/gpt-5.6-sol"])(
		"keeps %s on the gpt-5.6 preset",
		(modelId) => {
			expect(resolvePresetName(createModel(modelId), AUTO)).toBe("gpt-5.6");
		},
	);

	it.each([
		"gpt-6",
		"gpt-6-mini",
		"gpt-6.1",
		"gpt-61",
		"gpt-611-sol",
		"gpt-6-solaris",
		"gpt-6-lunar",
		"solar-pro",
		"luna-1",
	])("does not route %s to the GPT-6 family preset", (modelId) => {
		expect(resolvePresetName(createModel(modelId), AUTO) === "gpt-6-astra").toBe(false);
	});

	it.each(["openai-responses", "azure-openai-responses", "openai-codex-responses"] as const)(
		"keeps the preset and the apply_patch gate in agreement on %s for Sol and Luna",
		(api) => {
			for (const id of ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "openai/gpt-6-sol-fast", "gpt-6.1-sol-fast"]) {
				expect(resolvePresetName({ id, provider: "fixture" }, AUTO)).toBe("gpt-6-astra");
				expect(getApplyPatchWireMode({ api, id })).toBe("freeform");
			}
		},
	);

	it("returns the GPT-6 family preset for every GPT-6 Sol and Luna built-in catalog model", () => {
		// given
		const catalogModels = getGpt6SolAndLunaCatalogModels();
		expect(catalogModels.length).toBeGreaterThan(0);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, AUTO) !== "gpt-6-astra")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(misses).toEqual([]);
	});
});
