import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { GPT56_EXECUTION_RULES } from "../../src/core/extensions/builtin/prompt-preset/gpt-5.6.ts";
import {
	GPT6_ASTRA_RULES,
	type Gpt6AstraConcern,
	type Gpt6AstraRuleId,
} from "../../src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts";
import { buildGptEvalRoutingTuning } from "../../src/core/extensions/builtin/prompt-preset/gpt-eval-routing.ts";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import type { PromptPresetName } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";

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

function buildPrompt(presetName: PromptPresetName, modelId: string): string {
	const settings: PromptPresetSettings = { promptPreset: presetName };
	const preset = resolvePreset(createModel(modelId), settings, {
		cwd: "/repo",
		selectedTools: ["eval", "read", "bash", "monitor", "task", "todo"],
		toolSnippets: { eval: "Run one persistent code cell." },
		promptGuidelines: [],
		contextFiles: [],
		skills: [],
	});
	if (!preset) {
		throw new Error(`expected ${presetName} preset to resolve`);
	}
	return preset.prompt;
}

function sectionsOf(prompt: string): Map<string, string> {
	const sections = new Map<string, string>();
	for (const part of prompt.split(/^## /m).slice(1)) {
		const breakIndex = part.indexOf("\n");
		const heading = (breakIndex === -1 ? part : part.slice(0, breakIndex)).trim();
		sections.set(heading, breakIndex === -1 ? "" : part.slice(breakIndex + 1));
	}
	return sections;
}

function occurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function hasGpt6AstraCatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	// Keep in sync with presets.ts hasGpt6AstraSignal.
	return /(?:^|[/@:._-])gpt[._-]?6[._-]astra(?:$|[/@:._-])/.test(searchable);
}

function getGpt6AstraCatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasGpt6AstraCatalogSignal));
}

const EXPECTED_CONCERN: Record<Gpt6AstraRuleId, Gpt6AstraConcern> = {
	"initiative-bias": "initiative",
	"approval-last": "initiative",
	steering: "initiative",
	"no-unsolicited-caution": "initiative",
	"instruction-precedence": "instruction-precedence",
	"pause-transparency": "instruction-precedence",
	"eval-first-routing": "tool-orchestration",
	"parallel-batching": "tool-orchestration",
	"bun-runtime": "tool-orchestration",
	"over-call-bias": "tool-orchestration",
	"in-kernel-reduction": "tool-orchestration",
	"stay-direct-exceptions": "tool-orchestration",
	"lsp-symbol-routing": "symbol-routing",
	delegation: "delegation",
	"legible-messages": "delegation",
	"todo-granularity": "todo-discipline",
	"async-handles": "async-work",
	"turn-end-is-wait": "async-work",
	"monitor-conditions": "async-work",
	"verification-once": "verification",
	"test-first": "test-first",
	"failure-cap": "failure-recovery",
	"atomic-commits": "commit-discipline",
	"no-external-messaging": "external-side-effects",
	"plain-prose": "writing-style",
	"slop-ban": "writing-style",
	"direct-statements": "writing-style",
	"final-message-shape": "reporting",
};

const EXPECTED_SECTION: Record<Gpt6AstraRuleId, string> = {
	"initiative-bias": "Initiative",
	"approval-last": "Initiative",
	steering: "Initiative",
	"no-unsolicited-caution": "Initiative",
	"instruction-precedence": "Instructions From Files",
	"pause-transparency": "Instructions From Files",
	"eval-first-routing": "Working the Task",
	"parallel-batching": "Working the Task",
	"bun-runtime": "Working the Task",
	"over-call-bias": "Working the Task",
	"in-kernel-reduction": "Working the Task",
	"stay-direct-exceptions": "Working the Task",
	"lsp-symbol-routing": "Working the Task",
	delegation: "Working the Task",
	"legible-messages": "Working the Task",
	"todo-granularity": "Working the Task",
	"async-handles": "Asynchronous Work",
	"turn-end-is-wait": "Asynchronous Work",
	"monitor-conditions": "Asynchronous Work",
	"verification-once": "Verification",
	"test-first": "Verification",
	"failure-cap": "Scope and Recovery",
	"atomic-commits": "Hard Limits",
	"no-external-messaging": "Hard Limits",
	"plain-prose": "Writing",
	"slop-ban": "Writing",
	"direct-statements": "Writing",
	"final-message-shape": "Reporting",
};

describe("GPT-6 Astra prompt preset", () => {
	it.each([
		{ id: "gpt-6-astra", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6-astra-fast", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6-astra", provider: "openai-codex", api: "openai-codex-responses" as const },
		{ id: "gpt-6-astra-2026-09-01", provider: "openai", api: "openai-responses" as const },
		{ id: "openai/gpt-6-astra", provider: "openrouter", api: "openai-completions" as const },
		{ id: "openai.gpt-6-astra", provider: "amazon-bedrock", api: "bedrock-converse-stream" as const },
		{ id: "global.openai.gpt-6-astra", provider: "amazon-bedrock", api: "bedrock-converse-stream" as const },
		{ id: "azure/gpt-6-astra", provider: "custom", api: "openai-responses" as const },
		{ id: "GPT-6-Astra", provider: "custom", api: "openai-responses" as const },
		{ id: "gpt_6_astra", provider: "custom", api: "openai-completions" as const },
	])("resolves $provider/$id to the gpt-6-astra preset", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-6-astra");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("### Test Discipline");
	});

	it("resolves a display name carrying the model family when the id does not", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model: Model<Api> = { ...createModel("astra-default", "custom"), name: "GPT-6 Astra" };

		// when
		const name = resolvePresetName(model, settings);

		// then
		expect(name).toBe("gpt-6-astra");
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
	])("does not route %s to the gpt-6-astra preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };

		// when
		const name = resolvePresetName(createModel(modelId), settings);

		// then
		expect(name === "gpt-6-astra").toBe(false);
	});

	it("keeps gpt-5.6 on its own preset, distinct from gpt-6-astra", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };

		// when
		const sol = resolvePreset(createModel("gpt-5.6-sol"), settings);
		const astra = resolvePreset(createModel("gpt-6-astra"), settings);

		// then
		expect(sol?.name).toBe("gpt-5.6");
		expect(astra?.name).toBe("gpt-6-astra");
		expect(astra?.prompt).not.toBe(sol?.prompt);
	});

	it("allows settings.json to force gpt-6-astra regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "gpt-6-astra" };
		const model = createModel("some-random-model", "custom");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-6-astra");
	});

	it("returns the gpt-6-astra preset for every GPT-6 Astra built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getGpt6AstraCatalogModels();

		// when
		// A gpt-6-astra catalog entry may not have landed yet (it ships in a
		// separate PR); when it has, every matching model must resolve. The sweep
		// is a non-regression guard, so an empty catalog is allowed, not asserted.
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "gpt-6-astra")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(misses).toEqual([]);
	});
});

describe("GPT-6 Astra behavior contract", () => {
	it("models the Astra directives as parsed rule data instead of prompt snapshots", () => {
		// given
		const rulesById = new Map(GPT6_ASTRA_RULES.map((rule) => [rule.id, rule]));

		// then
		expect([...rulesById.keys()].sort()).toEqual(Object.keys(EXPECTED_CONCERN).sort());
		for (const [id, concern] of Object.entries(EXPECTED_CONCERN)) {
			expect(rulesById.get(id as Gpt6AstraRuleId)?.concern).toBe(concern);
		}
		for (const rule of GPT6_ASTRA_RULES) {
			expect(rule.directive.length).toBeGreaterThan(32);
			expect(rule.directive).not.toMatch(/\p{Extended_Pictographic}/u);
		}
		const asyncRules = GPT6_ASTRA_RULES.filter((rule) => rule.concern === "async-work");
		expect(asyncRules.length).toBeGreaterThanOrEqual(3);
	});

	it("renders the eval-cell and asynchronous-execution rules with bold emphasis and no other rule in bold", () => {
		// given
		const emphasized = new Set<Gpt6AstraRuleId>([
			"eval-first-routing",
			"parallel-batching",
			"async-handles",
			"turn-end-is-wait",
			"monitor-conditions",
		]);

		// then
		for (const rule of GPT6_ASTRA_RULES) {
			expect(rule.directive.includes("**"), `${rule.id} emphasis`).toBe(emphasized.has(rule.id));
		}
	});

	it("renders every directive exactly once, at its point of use in the core", () => {
		// given
		const prompt = buildPrompt("gpt-6-astra", "gpt-6-astra");
		const sections = sectionsOf(prompt);

		// then
		for (const rule of GPT6_ASTRA_RULES) {
			expect(occurrences(prompt, rule.directive), `directive ${rule.id} rendered once`).toBe(1);
			const section = sections.get(EXPECTED_SECTION[rule.id]);
			expect(section, `missing section for ${rule.id}`).toBeDefined();
			expect(section, `${rule.id} lives in ${EXPECTED_SECTION[rule.id]}`).toContain(rule.directive);
		}
	});

	it("keeps the shared GPT code-execution routing bridge and file-operations tuning once each", () => {
		// given
		const prompt = buildPrompt("gpt-6-astra", "gpt-6-astra");
		const sections = sectionsOf(prompt);
		const bridge = buildGptEvalRoutingTuning();

		// then
		expect(occurrences(prompt, bridge)).toBe(1);
		expect(sections.get("Working the Task")).toContain(bridge);
		expect(occurrences(prompt, "## File operations")).toBe(1);
		expect(prompt).toContain("apply_patch");
	});

	it("carries its own sections and the shared test discipline", () => {
		// given
		const headings = [...sectionsOf(buildPrompt("gpt-6-astra", "gpt-6-astra")).keys()];

		// then
		expect(headings).toEqual(
			expect.arrayContaining([
				"Intent Gate",
				"Initiative",
				"Instructions From Files",
				"Working the Task",
				"Asynchronous Work",
				"Verification",
				"Scope and Recovery",
				"Available Tools",
				"Hard Limits",
				"Writing",
				"Reporting",
				"Stop Goal",
			]),
		);
		expect(buildPrompt("gpt-6-astra", "gpt-6-astra")).toContain("### Test Discipline");
	});

	it("contains no emoji anywhere in the rendered prompt", () => {
		// given
		const prompt = buildPrompt("gpt-6-astra", "gpt-6-astra");

		// then
		expect(prompt).not.toMatch(/\p{Extended_Pictographic}/u);
	});

	it("keeps the GPT-5.6 execution contract out of the Astra core", () => {
		// given
		const prompt = buildPrompt("gpt-6-astra", "gpt-6-astra");

		// then
		for (const rule of GPT56_EXECUTION_RULES) {
			expect(prompt, `gpt-5.6 rule ${rule.id} leaked into astra`).not.toContain(rule.directive);
		}
	});

	it.each(["gpt-5.6", "gpt-5.5"] as const)("keeps the Astra contract out of %s", (presetName) => {
		// given
		const prompt = buildPrompt(presetName, presetName);

		// then
		for (const rule of GPT6_ASTRA_RULES) {
			expect(prompt, `astra rule ${rule.id} leaked into ${presetName}`).not.toContain(rule.directive);
		}
	});
});
