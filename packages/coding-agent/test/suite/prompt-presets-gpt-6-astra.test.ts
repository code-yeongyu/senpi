import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { resolvePreset, resolvePresetName } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

const AUTO = { promptPreset: "auto" } as const;

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
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
}

describe("GPT-6 Astra prompt preset", () => {
	it.each([
		{ id: "gpt-6-astra", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6-astra-fast", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6-astra", provider: "chatgpt-subscription", api: "openai-codex-responses" as const },
		{ id: "gpt-6-astra-2026-09-01", provider: "openai", api: "openai-responses" as const },
		{ id: "openai/gpt-6-astra", provider: "openrouter", api: "openai-completions" as const },
		{ id: "openai.gpt-6-astra", provider: "amazon-bedrock", api: "bedrock-converse-stream" as const },
		{ id: "global.openai.gpt-6-astra", provider: "amazon-bedrock", api: "bedrock-converse-stream" as const },
		{ id: "azure/gpt-6-astra", provider: "custom", api: "openai-responses" as const },
		{ id: "GPT-6-Astra", provider: "custom", api: "openai-responses" as const },
		{ id: "gpt_6_astra", provider: "custom", api: "openai-completions" as const },
	])("resolves $provider/$id to the gpt-6-astra preset", ({ id, provider, api }) => {
		const preset = resolvePreset(createModel(id, provider, api), AUTO);
		expect(preset?.name).toBe("gpt-6-astra");
		expect(preset?.prompt).toContain("## Intent Gate");
	});

	it("resolves a display name carrying the model family when the id does not", () => {
		const model = { ...createModel("astra-default", "custom"), name: "GPT-6 Astra" };
		expect(resolvePresetName(model, AUTO)).toBe("gpt-6-astra");
	});

	it.each([
		"gpt-5.6-sol",
		"gpt-5.6-astra",
		"gpt-6",
		"gpt-6-mini",
		"gpt-6.1",
		"astral-v1",
		"astra",
		"kimi-k3",
		"grok-4.6",
	])("does not route %s to the gpt-6-astra preset", (id) => {
		expect(resolvePresetName(createModel(id), AUTO)).not.toBe("gpt-6-astra");
	});

	it("keeps gpt-5.6 on its own preset, distinct from gpt-6-astra", () => {
		const sol = resolvePreset(createModel("gpt-5.6-sol"), AUTO);
		const astra = resolvePreset(createModel("gpt-6-astra"), AUTO);
		expect(sol?.name).toBe("gpt-5.6");
		expect(astra?.name).toBe("gpt-6-astra");
		expect(astra?.prompt).not.toBe(sol?.prompt);
	});

	it("allows settings.json to force gpt-6-astra regardless of model id", () => {
		const preset = resolvePreset(createModel("some-random-model", "custom"), { promptPreset: "gpt-6-astra" });
		expect(preset?.name).toBe("gpt-6-astra");
	});

	it("returns the gpt-6-astra preset for every GPT-6 Astra built-in catalog model", () => {
		const matching = getProviders()
			.flatMap((provider) => getModels(provider))
			.filter(({ id, name }) => /\bgpt[-_ ]6[-_ ]astra\b/i.test(`${id} ${name}`));
		expect(matching.map(({ id }) => id)).toContain("gpt-6-astra");
		for (const model of matching) {
			expect(resolvePresetName(model, AUTO), `${model.provider}/${model.id}`).toBe("gpt-6-astra");
		}
	});
});
