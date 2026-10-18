import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

const AUTO: PromptPresetSettings = { promptPreset: "auto" };

function createModel(id: string, provider: string, api: Api = "openai-responses", name: string = id): Model<Api> {
	return {
		id,
		name,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 32_768,
	};
}

const KIMI_CODE_PRESETS = {
	"kimi-for-coding": "kimi-k2-8",
	"kimi-for-coding-highspeed": "kimi-k2-7",
	k3: "kimi-k3",
	"k3-256k": "kimi-k3",
} as const;

function isKimiCodeVersionedId(id: string): id is keyof typeof KIMI_CODE_PRESETS {
	return id in KIMI_CODE_PRESETS;
}

describe("Kimi K2.8 prompt preset", () => {
	it.each([
		{ id: "kimi-for-coding", provider: "kimi-coding", api: "anthropic-messages" as const },
		{ id: "kimi-k2.8", provider: "moonshotai", api: "anthropic-messages" as const },
		{ id: "kimi-k2.8-code", provider: "moonshot", api: "openai-responses" as const },
		{ id: "kimi-k2p8-code", provider: "moonshot", api: "openai-responses" as const },
		{ id: "moonshotai/kimi-k2.8-code", provider: "openrouter", api: "openai-responses" as const },
		{ id: "moonshotai/kimi-k2.8:thinking", provider: "openrouter", api: "openai-responses" as const },
		{ id: "@cf/moonshotai/kimi-k2.8-code", provider: "workers-ai", api: "openai-responses" as const },
		{ id: "accounts/fireworks/models/kimi-k2p8-code", provider: "fireworks", api: "openai-responses" as const },
	])("returns the kimi-k2-8 preset for $provider/$id", ({ id, provider, api }) => {
		// given
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, AUTO);

		// then
		expect(preset?.name).toBe("kimi-k2-8");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("running on Kimi K2.8");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it("resolves a catalog model that carries the K2.8 version only in its display name", () => {
		// given
		const model = createModel("preview-alias", "custom", "openai-responses", "Kimi K2.8 Preview");

		// when
		const presetName = resolvePresetName(model, AUTO);

		// then
		expect(presetName).toBe("kimi-k2-8");
	});

	it("carries the Kimi K2.7 prompt verbatim apart from the model name", () => {
		// given
		const k27 = resolvePreset(createModel("kimi-k2.7-code", "moonshotai", "anthropic-messages"), AUTO);
		const k28 = resolvePreset(createModel("kimi-for-coding", "kimi-coding", "anthropic-messages"), AUTO);

		// then
		expect(k27?.name).toBe("kimi-k2-7");
		expect(k28?.name).toBe("kimi-k2-8");
		expect(k28?.prompt.replace("running on Kimi K2.8", "running on Kimi K2.7")).toBe(k27?.prompt);
	});

	it("routes every published Kimi Code catalog row to the preset its model version implies", () => {
		// given
		const rows = (getModels("kimi-coding") as Model<Api>[]).filter((model) => isKimiCodeVersionedId(model.id));

		// when
		const misses = rows
			.filter(
				(model) =>
					isKimiCodeVersionedId(model.id) && resolvePresetName(model, AUTO) !== KIMI_CODE_PRESETS[model.id],
			)
			.map((model) => `${model.id} -> ${resolvePresetName(model, AUTO)}`);

		// then
		expect(rows.map((model) => model.id)).toContain("kimi-for-coding");
		expect(misses).toEqual([]);
	});

	it.each([
		{ id: "kimi-for-coding-highspeed", provider: "kimi-coding", expected: "kimi-k2-7" },
		{ id: "kimi-k2.7-code", provider: "moonshotai", expected: "kimi-k2-7" },
		{ id: "kimi-k2.6-0528", provider: "moonshot", expected: "kimi-k2-6" },
		{ id: "k3", provider: "kimi-coding", expected: "kimi-k3" },
		{ id: "kimi-k3", provider: "moonshotai", expected: "kimi-k3" },
	])("leaves $provider/$id on the $expected preset", ({ id, provider, expected }) => {
		// given
		const model = createModel(id, provider, "anthropic-messages");

		// when
		const presetName = resolvePresetName(model, AUTO);

		// then
		expect(presetName).toBe(expected);
	});

	it("allows settings.json to force kimi-k2-8 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "kimi-k2-8" };
		const model = createModel("gpt-5.5", "chatgpt-subscription", "openai-codex-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k2-8");
		expect(preset?.prompt).toContain("running on Kimi K2.8");
	});

	it("respects model-level promptPreset metadata naming kimi-k2-8", () => {
		// given
		const model = { ...createModel("provider-specific-alias", "custom"), promptPreset: "kimi-k2-8" };

		// when
		const presetName = resolvePresetName(model, AUTO);

		// then
		expect(presetName).toBe("kimi-k2-8");
	});
});
