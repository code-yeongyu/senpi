import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	DEEPSEEK_V4_RULES,
	type DeepseekV4PresetName,
} from "../../src/core/extensions/builtin/prompt-preset/deepseek-v4.ts";
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

// Real-world ID shapes verified against the OpenRouter live API, models.dev
// (opencode), and senpi's own generated provider catalogs on 2026-07-31.
const FLASH_MODEL_IDS = [
	"deepseek-v4-flash", // DeepSeek official API, alibaba/qwen token plans, azure, opencode
	"deepseek/deepseek-v4-flash", // OpenRouter, vercel-ai-gateway, novita
	"deepseek-ai/DeepSeek-V4-Flash", // huggingface, deepinfra, siliconflow
	"deepseek-ai/deepseek-v4-flash", // nvidia
	"accounts/fireworks/models/deepseek-v4-flash", // fireworks
	"alicloud-deepseek-v4-flash", // aihubmix (alibaba route)
	"deep-deepseek-v4-flash", // aihubmix (deepseek route)
	"cline-pass/deepseek-v4-flash",
	"deepseek-v4-flash:free", // kenari, unorouter
	"deepseek-v4-flash-free", // opencode free tier
	"deepseek/deepseek-v4-flash:thinking", // nano-gpt
	"deepseek-v4-flash-nothinking", // ds2api-style gateways
	"empiriolabs/deepseek-v4-flash-el", // poe
	"DeepSeek-V4-Flash", // ebcloud
	"DeepSeek V4 Flash", // display-name matching
];

const FLASH_0731_MODEL_IDS = [
	"deepseek/deepseek-v4-flash-0731", // OpenRouter dated snapshot
	"deepseek-v4-flash-0731", // aggregator pricing catalogs
	"deepseek-ai/DeepSeek-V4-Flash-0731", // HF-style snapshot
	"DeepSeek V4 Flash 0731", // display-name matching
];

const PRO_MODEL_IDS = [
	"deepseek-v4-pro", // DeepSeek official API, digitalocean, venice
	"deepseek/deepseek-v4-pro", // OpenRouter, vercel-ai-gateway
	"deepseek-ai/DeepSeek-V4-Pro", // huggingface, together, nebius
	"accounts/fireworks/models/deepseek-v4-pro", // fireworks
	"TEE/deepseek-v4-pro:thinking", // nano-gpt TEE
	"deepseek/deepseek-v4-pro-cheaper:thinking", // nano-gpt
	"deepseek-v4-pro-lightning", // crof
	"deepseek-v4-pro-nothinking", // ds2api-style gateways
	"deepseek-v4-pro:free", // unorouter
	"DeepSeek V4 Pro", // display-name matching
];

const NON_MATCHING_MODEL_IDS = [
	"deepseek-v3.2",
	"deepseek/deepseek-chat-v3-0324",
	"deepseek/deepseek-chat",
	"deepseek/deepseek-r1-0528",
	"deepseek.v3-v1:0", // bedrock
	"deepseek-v4", // no variant
	"v4-flash", // no deepseek signal
	"mimo-v2-pro",
	"some-deepseek-router",
];

function hasFlash0731Signal(searchable: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash[._-]0731(?:$|[/@:._-])/.test(searchable);
}

function hasFlashSignal(searchable: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash(?:$|[/@:._-])/.test(searchable);
}

function hasProSignal(searchable: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]pro(?:$|[/@:._-])/.test(searchable);
}

function expectedCatalogPreset(model: Model<Api>): string | undefined {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	if (hasFlash0731Signal(searchable)) {
		return "deepseek-v4-flash-0731";
	}
	if (hasFlashSignal(searchable)) {
		return "deepseek-v4-flash";
	}
	if (hasProSignal(searchable)) {
		return "deepseek-v4-pro";
	}
	return undefined;
}

function getDeepseekV4CatalogModels(): Array<{ model: Model<Api>; expected: string }> {
	return getProviders().flatMap((provider) =>
		(getModels(provider) as Model<Api>[])
			.map((model) => ({ model, expected: expectedCatalogPreset(model) }))
			.filter((entry): entry is { model: Model<Api>; expected: string } => entry.expected !== undefined),
	);
}

describe("DeepSeek V4 prompt presets", () => {
	it.each(FLASH_MODEL_IDS)("resolves %s to the deepseek-v4-flash preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("deepseek-v4-flash");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).not.toContain("apply_patch");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each(FLASH_0731_MODEL_IDS)("resolves %s to the deepseek-v4-flash-0731 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("deepseek-v4-flash-0731");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each(PRO_MODEL_IDS)("resolves %s to the deepseek-v4-pro preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("deepseek-v4-pro");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each(NON_MATCHING_MODEL_IDS)("does not route %s to any deepseek-v4 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter");

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name === undefined || !name.startsWith("deepseek")).toBe(true);
	});

	it("matches by display name when the raw id carries no signal", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = { ...createModel("gateway-alias-77", "custom"), name: "DeepSeek V4 Flash 0731" };

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name).toBe("deepseek-v4-flash-0731");
	});

	it.each(["deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4-pro"] as const)(
		"allows settings.json to force %s regardless of model id",
		(presetName) => {
			// given
			const settings = { promptPreset: presetName } as PromptPresetSettings;
			const model = createModel("some-random-model", "custom");

			// when
			const preset = resolvePreset(model, settings);

			// then
			expect(preset?.name).toBe(presetName);
		},
	);

	it("returns the correct preset for every DeepSeek V4 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogEntries = getDeepseekV4CatalogModels();
		const catalogModelIds = catalogEntries.map(({ model }) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogEntries
			.filter(({ model, expected }) => resolvePresetName(model, settings) !== expected)
			.map(({ model, expected }) => `${model.provider}/${model.id} != ${expected}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"deepseek/deepseek-v4-flash",
				"deepseek/deepseek-v4-pro",
				"openrouter/deepseek/deepseek-v4-flash-0731",
				"openrouter/deepseek/deepseek-v4-flash",
				"openrouter/deepseek/deepseek-v4-pro",
				"opencode/deepseek-v4-flash-free",
				"huggingface/deepseek-ai/DeepSeek-V4-Flash",
				"together/deepseek-ai/DeepSeek-V4-Pro",
			]),
		);
		expect(misses).toEqual([]);
	});
});

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function buildPresetPrompt(presetName: DeepseekV4PresetName): string {
	const settings = { promptPreset: presetName } as PromptPresetSettings;
	const preset = resolvePreset(createModel("any-model", "custom"), settings);
	if (!preset) {
		throw new Error(`preset ${presetName} did not resolve`);
	}
	return preset.prompt;
}

describe("DeepSeek V4 rule data", () => {
	const presetNames: readonly DeepseekV4PresetName[] = [
		"deepseek-v4-flash",
		"deepseek-v4-flash-0731",
		"deepseek-v4-pro",
	];

	it("keeps the rule set well-formed", () => {
		const ids = DEEPSEEK_V4_RULES.map((rule) => rule.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const rule of DEEPSEEK_V4_RULES) {
			expect(rule.presets.length).toBeGreaterThan(0);
			expect(rule.directive.length).toBeGreaterThan(80);
		}
		// The documented 0731 failure modes each have an owning rule on the 0731 preset.
		const on0731 = DEEPSEEK_V4_RULES.filter((rule) => rule.presets.includes("deepseek-v4-flash-0731"));
		const concerns = new Set(on0731.map((rule) => rule.concern));
		expect(concerns.has("harness-contract")).toBe(true);
		expect(concerns.has("todo")).toBe(true);
		expect(concerns.has("deliberation")).toBe(true);
	});

	it.each(presetNames)("renders every owning rule exactly once in %s", (presetName) => {
		// given
		const prompt = buildPresetPrompt(presetName);

		// then
		for (const rule of DEEPSEEK_V4_RULES) {
			const expected = rule.presets.includes(presetName) ? 1 : 0;
			expect(countOccurrences(prompt, rule.directive), `${rule.id} in ${presetName}`).toBe(expected);
		}
	});

	it("differentiates the 0731 snapshot prompt from the generic flash prompt", () => {
		expect(buildPresetPrompt("deepseek-v4-flash-0731")).not.toBe(buildPresetPrompt("deepseek-v4-flash"));
	});

	it("does not leak DeepSeek rules into other presets", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const otherPrompts = [
			resolvePreset(createModel("kimi-k3", "moonshot"), settings)?.prompt,
			resolvePreset(createModel("gpt-5.6-sol", "openai"), settings)?.prompt,
			resolvePreset(createModel("glm-5.2", "zai"), settings)?.prompt,
		];

		// then
		for (const prompt of otherPrompts) {
			expect(prompt).toBeDefined();
			for (const rule of DEEPSEEK_V4_RULES) {
				expect(prompt).not.toContain(rule.directive);
			}
		}
	});
});
