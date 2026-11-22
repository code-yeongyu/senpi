import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { PromptSurface } from "../../src/core/dynamic-prompt/build.ts";
import { buildWorkstationSection } from "../../src/core/dynamic-prompt/workstation.ts";
import { DEEPSEEK_V4_RULES } from "../../src/core/extensions/builtin/prompt-preset/deepseek-v4.ts";
import {
	DEEPSEEK_V41_FLASH_RULES,
	DEEPSEEK_V41_FLASH_SECTIONS,
	type DeepseekV41FlashRule,
} from "../../src/core/extensions/builtin/prompt-preset/deepseek-v4-1-flash-rules.ts";
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
	// The 2026-10-17 snapshot (DeepSeek-V4.1-Flash-1017): the official API serves it
	// as deepseek-flash; gateways list it under a dated id.
	["deepseek/deepseek-v4.1-flash-1017", "openrouter"],
	["deepseek/deepseek-v4.1-flash-1017", "vercel-ai-gateway"],
	["deepseek/deepseek-v4.1-flash-1017", "kilo"],
	["deepseek-ai/DeepSeek-V4.1-Flash-1017", "baseten"],
];

// Every shipped catalog row of the 1017 snapshot, read from the catalogs themselves (id or display name),
// so a row added later is checked without editing this file.
const SNAPSHOT_1017 = /v4[.p -]?1[- ]flash[- (]+1017/i;
const SHIPPED_1017_ROWS: ReadonlyArray<readonly [provider: string, id: string, model: Model<Api>]> =
	getProviders().flatMap((provider) =>
		getModels(provider)
			.filter((model) => SNAPSHOT_1017.test(`${model.id} ${model.name}`))
			.map((model) => [provider, model.id, model] as const),
	);

// Rows known to ship on 2026-10-20; removing one from its catalog must fail the suite.
const KNOWN_1017_ROWS: ReadonlyArray<readonly [provider: string, id: string]> = [
	["baseten", "deepseek-ai/DeepSeek-V4.1-Flash-1017"],
	["baseten", "deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast"],
	["fireworks", "accounts/fireworks/models/deepseek-v4p1-flash-1017"],
	["opengateway", "deepseek/deepseek-flash"],
	["openrouter", "deepseek/deepseek-v4.1-flash-1017"],
	["qwen-token-plan-cn", "deepseek-v4.1-flash-1017"],
	["venice", "deepseek-v4-1-flash-1017"],
	["vercel-ai-gateway", "deepseek/deepseek-v4.1-flash-1017"],
	["vercel-ai-gateway", "deepseek/deepseek-v4.1-flash-1017-fast"],
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
		getModels(provider).filter((model) => {
			const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
			return hasV41Signal(searchable) || (model.provider === "deepseek" && hasV4FlashSignal(searchable));
		}),
	);
}

// Image input and reasoning are per-provider serving choices, not snapshot facts: models.dev lists mistral's
// deepseek-v4-1-flash-1017 as text-only (attachment false), so the release's catalog regeneration can add such a
// row (senpi#4762). Every shipped row must reach the V4.1 preset; the curated KNOWN_1017_ROWS pin the multimodal set.
function expectShipped1017Row(model: Model<Api>): void {
	expect(model.input).toContain("text");
	expect(resolvePresetName(model, AUTO)).toBe("deepseek-v4-1-flash");
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
		// Catalog ids drift across regenerations: the official provider renamed
		// its row deepseek-v4-flash -> deepseek-flash after V4 Flash retired on
		// 2026-09-10, and opencode-go renamed deepseek-flash -> deepseek-v4.1-flash
		// on 2026-09-11 (fork main PR #1619 pinned the retired official spelling;
		// upstream 12f59336a + 713bdf38d renamed the row and the 2026-09-12 merge
		// regenerated the catalog). Pin each provider's presence in the V4.1 set,
		// not one spelling.
		expect(catalogModelIds.some((id) => id.startsWith("deepseek/"))).toBe(true);
		expect(catalogModelIds.some((id) => id.startsWith("opencode-go/"))).toBe(true);
		expect(misses).toEqual([]);
	});

	it.each(SHIPPED_1017_ROWS)("ships the 1017 snapshot row on %s (%s) on the V4.1 preset", (_provider, _id, model) => {
		expectShipped1017Row(model);
	});

	it("accepts a text-only 1017 row as the release's catalog regeneration can add one", () => {
		// given models.dev's mistral row, served text-only upstream
		const model = { ...createModel("deepseek-v4-1-flash-1017", "mistral"), input: ["text"] } satisfies Model<Api>;

		// then
		expectShipped1017Row(model);
	});

	it.each(KNOWN_1017_ROWS)(
		"still ships the 1017 snapshot row on %s (%s) as a multimodal reasoning row",
		(provider, id) => {
			// when
			const model = SHIPPED_1017_ROWS.find(([p, i]) => p === provider && i === id)?.[2];

			// then
			expect(model?.reasoning).toBe(true);
			expect(model?.input).toContain("image");
		},
	);
});

// senpi#7100: the core is rule data rendered once per rule under the section that owns it.
describe("DeepSeek V4.1 Flash core", () => {
	const FORCED: PromptPresetSettings = { promptPreset: "deepseek-v4-1-flash" };
	const SURFACES: readonly PromptSurface[] = ["terminal", "app", "chat"];
	const RULES: readonly DeepseekV41FlashRule[] = DEEPSEEK_V41_FLASH_RULES;
	const TOOL_BOUND = RULES.filter((rule) => rule.requiresTool !== undefined);
	const UNBOUND_TOOLS = ["read", "edit", "bash"];
	const SESSION_TOOLS = [...UNBOUND_TOOLS, ...new Set(TOOL_BOUND.flatMap((rule) => rule.requiresTool ?? []))];

	function render(selectedTools: readonly string[], surface: PromptSurface): string {
		const preset = resolvePreset(createModel("deepseek-flash", "deepseek"), FORCED, {
			cwd: "/workspace",
			selectedTools: [...selectedTools],
			toolSnippets: { read: "READ_SNIPPET" },
			promptGuidelines: ["GUIDELINE_SENTINEL"],
			contextFiles: [],
			skills: [],
			surface,
		});
		if (!preset) {
			throw new Error("deepseek-v4-1-flash did not resolve");
		}
		return preset.prompt;
	}

	function sectionsOf(prompt: string): Map<string, string> {
		const sections = new Map<string, string>();
		for (const part of prompt.split(/^## /m).slice(1)) {
			const breakIndex = part.indexOf("\n");
			sections.set(part.slice(0, breakIndex).trim(), part.slice(breakIndex + 1));
		}
		return sections;
	}

	function occurrences(haystack: string, needle: string): number {
		return haystack.split(needle).length - 1;
	}

	it.each(SURFACES)("renders each rule of the %s surface once, under its own section", (surface) => {
		// given
		const prompt = render(SESSION_TOOLS, surface);
		const sections = sectionsOf(prompt);

		// then
		for (const rule of RULES) {
			const expected = rule.surfaces === undefined || rule.surfaces.includes(surface) ? 1 : 0;
			expect(occurrences(prompt, rule.directive), rule.id).toBe(expected);
			expect(occurrences(sections.get(rule.section) ?? "", rule.directive), `${rule.id} in ${rule.section}`).toBe(
				expected,
			);
		}
		expect([...sections.keys()]).toEqual([...DEEPSEEK_V41_FLASH_SECTIONS, "Tool Guidelines"]);
	});

	it("renders a tool-bound rule for any one of its tools and drops it without them", () => {
		// given
		expect(TOOL_BOUND.length).toBeGreaterThan(0);
		const unbound = render(UNBOUND_TOOLS, "terminal");

		// then
		for (const rule of TOOL_BOUND) {
			expect(occurrences(unbound, rule.directive), `${rule.id} without its tools`).toBe(0);
			const surface = rule.surfaces?.[0] ?? "terminal";
			for (const tool of rule.requiresTool ?? []) {
				expect(occurrences(render(["read", tool], surface), rule.directive), `${rule.id} with ${tool}`).toBe(1);
			}
		}
	});

	it("drops a section whose rules are all unmounted", () => {
		// given
		const emptied = DEEPSEEK_V41_FLASH_SECTIONS.filter((section) =>
			RULES.filter((rule) => rule.section === section).every((rule) => rule.requiresTool !== undefined),
		);
		expect(emptied.length).toBeGreaterThan(0);

		// when
		const sections = sectionsOf(render(UNBOUND_TOOLS, "terminal"));

		// then
		for (const section of emptied) expect(sections.has(section), section).toBe(false);
	});

	it("keeps the guidelines and renders no tool list", () => {
		// when
		const sections = sectionsOf(render(SESSION_TOOLS, "terminal"));

		// then
		expect(sections.get("Tool Guidelines")).toContain("GUIDELINE_SENTINEL");
		expect(sections.has("Available Tools")).toBe(false);
		expect([...sections.values()].join("\n")).not.toContain("READ_SNIPPET");
	});

	it("shares no rule text with the V4 presets", () => {
		// when
		const prompt = render(SESSION_TOOLS, "terminal");

		// then
		for (const rule of DEEPSEEK_V4_RULES) expect(prompt, rule.id).not.toContain(rule.directive);
	});

	// The emphasis budget of this core: no bold, no capitalized emphasis, and "Never" only for the
	// invariants (the limits and the refusal rule).
	it("spends no emphasis outside the limits and the refusal rule", () => {
		for (const rule of RULES) {
			expect(rule.directive, rule.id).not.toMatch(/\*\*|\b[A-Z]{3,}\b|\p{Extended_Pictographic}/u);
			const invariant = rule.section === "Limits" || rule.id === "refusal-is-final";
			expect(/\bNever\b/.test(rule.directive), rule.id).toBe(invariant);
		}
	});

	it("uses the codex workstation dialect", () => {
		// given
		const workstation = buildWorkstationSection({ selectedTools: ["bash"], dialect: "codex" });

		// then
		expect(render(["bash"], "terminal")).toContain(workstation);
	});
});
