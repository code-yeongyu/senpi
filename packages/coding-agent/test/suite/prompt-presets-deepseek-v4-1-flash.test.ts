import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { DEEPSEEK_V4_RULES } from "../../src/core/extensions/builtin/prompt-preset/deepseek-v4.ts";
import { EXECUTION_TOOLING_RULES } from "../../src/core/extensions/builtin/prompt-preset/execution-tooling.ts";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider: string, name = id): Model<Api> {
	return {
		id,
		name,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
	};
}

const AUTO: PromptPresetSettings = { promptPreset: "auto" };

// Real-world id shapes verified against models.dev and senpi's generated
// provider catalogs on 2026-09-11, the day after the V4.1 Flash release.
const V41_FLASH_MODEL_IDS: ReadonlyArray<readonly [id: string, provider: string]> = [
	["deepseek-flash", "deepseek"], // official API name
	["deepseek-flash", "opencode-go"],
	["deepseek-v4.1-flash", "requesty"],
	["deepseek-v4.1-flash", "llmgateway"],
	["deepseek/deepseek-v4.1-flash", "openrouter"],
	["deepseek/deepseek-v4.1-flash", "vercel-ai-gateway"],
	["deepseek/deepseek-v4.1-flash:thinking", "nano-gpt"],
	["deepseek-ai/DeepSeek-V4.1-Flash", "huggingface"],
	["deepseek-ai/DeepSeek-V4.1-Flash", "deepinfra"],
	["deepinfra/deepseek-ai/DeepSeek-V4.1-Flash", "edenai"],
	["accounts/fireworks/models/deepseek-v4p1-flash", "fireworks"],
	["deepseek-v4-1-flash", "venice"],
	["DeepSeek-V4.1-Flash", "custom"],
];

// The official API retired V4 Flash on 2026-09-10 and serves these names with V4.1 Flash.
const RETIRED_OFFICIAL_ALIASES = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];

// The same names on every other provider still resolve to the V4 weights.
const V4_FLASH_ELSEWHERE: ReadonlyArray<readonly [id: string, provider: string, expected: string]> = [
	["deepseek-v4-flash", "openrouter", "deepseek-v4-flash"],
	["deepseek/deepseek-v4-flash", "openrouter", "deepseek-v4-flash"],
	["deepseek-ai/DeepSeek-V4-Flash", "huggingface", "deepseek-v4-flash"],
	["deepseek-v4-flash-vision-exp", "opencode", "deepseek-v4-flash"],
	["deepseek/deepseek-v4-flash-0731", "openrouter", "deepseek-v4-flash-0731"],
	["deepseek-v4-flash-0731", "deepseek", "deepseek-v4-flash-0731"],
	["deepseek-v4-pro", "deepseek", "deepseek-v4-pro"],
];

const NON_MATCHING_MODEL_IDS = [
	"deepseek-v4.1-pro",
	"deepseek-v4",
	"deepseek-v41",
	"deepseek-chat",
	"deepseek-reasoner",
	"deepseek/deepseek-r1",
	"flash",
	"gemini-3.6-flash",
	"qwen3.6-flash",
];

function hasV41Signal(searchable: string): boolean {
	return (
		/(?:^|[/@:._-])deepseek[._-]v4(?:[._-]1|p1)[._-]flash(?:$|[/@:._-])/.test(searchable) ||
		/(?:^|[/@:._-])deepseek[._-]flash(?:$|[/@:._-])/.test(searchable)
	);
}

function hasV4FlashSignal(searchable: string): boolean {
	return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash(?:$|[/@:._-])/.test(searchable);
}

function getV41CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) =>
		(getModels(provider) as Model<Api>[]).filter((model) => {
			const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
			return hasV41Signal(searchable) || (model.provider === "deepseek" && hasV4FlashSignal(searchable));
		}),
	);
}

describe("DeepSeek V4.1 Flash prompt preset", () => {
	it.each(V41_FLASH_MODEL_IDS)("resolves %s on %s to the deepseek-v4-1-flash preset", (modelId, provider) => {
		// when
		const preset = resolvePreset(createModel(modelId, provider), AUTO);

		// then
		expect(preset?.name).toBe("deepseek-v4-1-flash");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).not.toContain("apply_patch");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it("matches by display name when the raw id carries no signal", () => {
		// given
		const model = createModel("ds-flash-latest", "aggregator", "DeepSeek V4.1 Flash");

		// then
		expect(resolvePresetName(model, AUTO)).toBe("deepseek-v4-1-flash");
	});

	it.each(RETIRED_OFFICIAL_ALIASES)("routes the retired official alias %s to the V4.1 preset", (modelId) => {
		expect(resolvePresetName(createModel(modelId, "deepseek"), AUTO)).toBe("deepseek-v4-1-flash");
	});

	it.each(V4_FLASH_ELSEWHERE)("keeps %s on %s on the %s preset", (modelId, provider, expected) => {
		expect(resolvePresetName(createModel(modelId, provider), AUTO)).toBe(expected);
	});

	it.each(NON_MATCHING_MODEL_IDS)("does not route %s to the V4.1 preset", (modelId) => {
		expect(resolvePresetName(createModel(modelId, "openrouter", "some model"), AUTO)).not.toBe("deepseek-v4-1-flash");
	});

	it("allows settings.json to force the preset regardless of model id", () => {
		// given
		const settings = { promptPreset: "deepseek-v4-1-flash" } as PromptPresetSettings;

		// when
		const preset = resolvePreset(createModel("some-random-model", "custom"), settings);

		// then
		expect(preset?.name).toBe("deepseek-v4-1-flash");
	});

	it("returns the V4.1 preset for every V4.1 Flash built-in catalog model", () => {
		// given
		const catalogModels = getV41CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, AUTO) !== "deepseek-v4-1-flash")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"deepseek/deepseek-v4-flash",
				"openrouter/deepseek/deepseek-v4.1-flash",
				"vercel-ai-gateway/deepseek/deepseek-v4.1-flash",
			]),
		);
		// opencode-go renames its V4.1 Flash id between catalog regenerations
		// (deepseek-flash -> deepseek-v4.1-flash on 2026-09-11); pin the provider's
		// presence in the V4.1 set, not one spelling.
		expect(catalogModelIds.some((id) => id.startsWith("opencode-go/"))).toBe(true);
		expect(misses).toEqual([]);
	});
});

describe("DeepSeek V4.1 Flash prompt content", () => {
	const settings = { promptPreset: "deepseek-v4-1-flash" } as PromptPresetSettings;

	function buildPrompt(selectedTools: string[]): string {
		const preset = resolvePreset(createModel("deepseek-flash", "deepseek"), settings, {
			cwd: "/workspace",
			selectedTools,
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		});
		if (!preset) {
			throw new Error("deepseek-v4-1-flash did not resolve");
		}
		return preset.prompt;
	}

	it("carries none of the V4 Flash repair rules", () => {
		// given
		const prompt = buildPrompt(["read", "edit", "bash", "eval", "todo"]);

		// then
		for (const rule of DEEPSEEK_V4_RULES) {
			expect(prompt, rule.id).not.toContain(rule.directive);
		}
		expect(prompt).not.toContain("You are running on DeepSeek");
	});

	it("renders the claude-dialect eval-routing stance only when eval is selected", () => {
		// given
		const withEval = buildPrompt(["read", "edit", "bash", "eval"]);
		const withoutEval = buildPrompt(["read", "edit", "bash"]);

		// then
		expect(withEval).toContain("<execution_tooling>");
		expect(withoutEval).not.toContain("<execution_tooling>");
		for (const rule of EXECUTION_TOOLING_RULES) {
			expect(withEval).toContain(rule.directive.claude);
			expect(withoutEval).not.toContain(rule.directive.claude);
		}
	});

	it("uses the claude workstation dialect", () => {
		expect(buildPrompt(["bash"])).toContain("<execution_context>");
	});
});
