import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { BuildDynamicSystemPromptOptions } from "../../src/core/dynamic-prompt/build.ts";
import { buildGeminiPrompt } from "../../src/core/extensions/builtin/prompt-preset/gemini.ts";
import { buildMuseSparkPrompt } from "../../src/core/extensions/builtin/prompt-preset/muse-spark.ts";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import { parsePromptPreset } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";

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

const OPTIONS: BuildDynamicSystemPromptOptions = {
	cwd: "/test/project",
	selectedTools: ["read", "bash", "edit", "write"],
	toolSnippets: {
		read: "Read file contents",
		bash: "Execute shell commands",
		edit: "Apply surgical edits",
		write: "Create or overwrite files",
	},
	promptGuidelines: [],
	contextFiles: [],
	skills: [],
};

// Real-world id shapes verified against senpi's generated provider catalogs
// (2026-08-16): the exact registry ids, plus the unprefixed, :batch-tagged,
// -preview-suffixed, and display-name shapes those catalogs carry.
const GEMINI_MODEL_IDS = [
	"google/gemini-3.6-flash", // openrouter, vercel-ai-gateway
	"google/gemini-3.1-flash-lite", // openrouter, vercel-ai-gateway
	"google/gemini-3.5-flash", // openrouter, vercel-ai-gateway
	"google/gemini-3.5-flash-lite", // openrouter, vercel-ai-gateway
	"google/gemini-3.7-flash", // contract-listed registry id
	"gemini-3.6-flash", // google, google-vertex, github-copilot, opencode
	"gemini-3.5-flash", // google, google-vertex, github-copilot, opencode
	"gemini-3.5-flash-lite", // google, google-vertex, opencode
	"gemini-3.1-flash-lite", // google, google-vertex
	"opengateway/google/gemini-3.5-flash", // extra path segment
	"google/gemini-3.6-flash:batch", // openrouter batch tag
	"google/gemini-3.5-flash-lite:batch", // openrouter batch tag
	"google/gemini-3.1-flash-lite-preview", // preview suffix
	"Gemini 3.6 Flash", // display-name matching
];

const MUSE_SPARK_MODEL_IDS = [
	"meta/muse-spark-1.1", // openrouter, vercel-ai-gateway
	"meta/muse-spark-1.2", // openrouter, vercel-ai-gateway
	"meta/muse-spark-1.2-contributor", // vercel-ai-gateway
	"Muse Spark 1.2", // display-name matching
];

const NON_MATCHING_MODEL_IDS = [
	"google/gemini-3-flash", // no minor version - not a listed id
	"google/gemini-3-flash-preview",
	"google/gemini-2.5-flash", // previous generation
	"google/gemini-3.1-pro-preview", // pro line, not flash
	"google/gemini-3.1-flash-image", // image modality
	"google/gemini-3.1-flash-lite-image", // image modality (Nano Banana 2 Lite)
	"google/gemini-3-pro-image",
	"meta/muse-spark-1.3", // not a listed id
	"meta/muse-spark-2.0",
	"my-gemini-router", // bare substring, no versioned id
	"spark-1.2", // no muse signal
	"mimo-v2-pro",
];

function hasGeminiCatalogSignal(searchable: string): boolean {
	return /(?:^|[/@:._-])gemini[._-]3[._-](?:1[._-]flash[._-]lite|5[._-]flash(?:[._-]lite)?|6[._-]flash|7[._-]flash)(?:$|[/@:._-])(?!image(?:$|[/@:._-]))/.test(
		searchable,
	);
}

function hasMuseSparkCatalogSignal(searchable: string): boolean {
	return /(?:^|[/@:._-])muse[._-]spark[._-]1[._-][12](?:$|[/@:._-])/.test(searchable);
}

function expectedCatalogPreset(model: Model<Api>): "gemini" | "muse-spark" | undefined {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	if (hasGeminiCatalogSignal(searchable)) {
		return "gemini";
	}
	if (hasMuseSparkCatalogSignal(searchable)) {
		return "muse-spark";
	}
	return undefined;
}

function getGeminiMuseCatalogModels(): Array<{ model: Model<Api>; expected: "gemini" | "muse-spark" }> {
	return getProviders().flatMap((provider) =>
		(getModels(provider) as Model<Api>[])
			.map((model) => ({ model, expected: expectedCatalogPreset(model) }))
			.filter(
				(entry): entry is { model: Model<Api>; expected: "gemini" | "muse-spark" } => entry.expected !== undefined,
			),
	);
}

describe("Gemini prompt preset routing", () => {
	it.each(GEMINI_MODEL_IDS)("resolves %s to the gemini preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter");

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name).toBe("gemini");
	});

	it("matches by display name when the raw id carries no signal", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = { ...createModel("gateway-alias-12", "custom"), name: "Google: Gemini 3.5 Flash Lite" };

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name).toBe("gemini");
	});
});

describe("Muse Spark prompt preset routing", () => {
	it.each(MUSE_SPARK_MODEL_IDS)("resolves %s to the muse-spark preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter");

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name).toBe("muse-spark");
	});
});

describe("Gemini/Muse Spark routing boundaries", () => {
	it.each(["google/gemini-3.6", "meta/muse-spark"])("leaves truncated id %s unresolved", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter");

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name).toBeUndefined();
	});

	it.each(NON_MATCHING_MODEL_IDS)("does not route %s to the gemini or muse-spark preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "openrouter");

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name === undefined || (name !== "gemini" && name !== "muse-spark")).toBe(true);
	});

	it("keeps deepseek/deepseek-v4-pro on its existing preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("deepseek/deepseek-v4-pro", "openrouter");

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name).toBe("deepseek-v4-pro");
	});

	it("returns the correct preset for every Gemini/Muse built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogEntries = getGeminiMuseCatalogModels();
		const catalogModelIds = catalogEntries.map(({ model }) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogEntries
			.filter(({ model, expected }) => resolvePresetName(model, settings) !== expected)
			.map(({ model, expected }) => `${model.provider}/${model.id} != ${expected}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"google/gemini-3.6-flash",
				"google/gemini-3.5-flash",
				"openrouter/google/gemini-3.6-flash",
				"openrouter/google/gemini-3.6-flash:batch",
				"vercel-ai-gateway/google/gemini-3.5-flash-lite",
				"github-copilot/gemini-3.6-flash",
				"google-vertex/gemini-3.6-flash",
				"opencode/gemini-3.5-flash",
				"openrouter/meta/muse-spark-1.1",
				"openrouter/meta/muse-spark-1.2",
				"vercel-ai-gateway/meta/muse-spark-1.2-contributor",
			]),
		);
		expect(misses).toEqual([]);
	});
});

describe("Gemini/Muse Spark preset settings and tokens", () => {
	it.each(["gemini", "muse-spark"] as const)("accepts %s as a valid promptPreset setting", (presetName) => {
		expect(parsePromptPreset(presetName)).toBe(presetName);
	});

	it.each(["gemini", "muse-spark"] as const)(
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

	it("stamps the gemini prompt with its model-family token", () => {
		// given / when
		const prompt = buildGeminiPrompt(OPTIONS);

		// then
		expect(prompt).toContain("model-family: gemini");
		expect(prompt).not.toContain("model-family: muse-spark");
	});

	it("stamps the muse-spark prompt with its model-family token", () => {
		// given / when
		const prompt = buildMuseSparkPrompt(OPTIONS);

		// then
		expect(prompt).toContain("model-family: muse-spark");
		expect(prompt).not.toContain("model-family: gemini");
	});
});
