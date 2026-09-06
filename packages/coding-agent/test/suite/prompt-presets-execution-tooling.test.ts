import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	EXECUTION_TOOLING_RULES,
	type ExecutionToolingConcern,
	type ExecutionToolingDialect,
	type ExecutionToolingRuleId,
} from "../../src/core/extensions/builtin/prompt-preset/execution-tooling.ts";
import { type PromptPresetSettings, resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import type { PromptPresetName } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";

function createModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

function buildPrompt(presetName: PromptPresetName, selectedTools: readonly string[]): string {
	const settings: PromptPresetSettings = { promptPreset: presetName };
	const preset = resolvePreset(createModel(presetName), settings, {
		cwd: "/repo",
		selectedTools: [...selectedTools],
		toolSnippets: Object.fromEntries(selectedTools.map((name) => [name, `${name} snippet`])),
		promptGuidelines: [],
		contextFiles: [],
		skills: [],
	});
	if (!preset) {
		throw new Error(`expected ${presetName} preset to resolve`);
	}
	return preset.prompt;
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

const EXPECTED_CONCERN: Record<ExecutionToolingRuleId, ExecutionToolingConcern> = {
	"eval-default-surface": "code-cell-routing",
	"eval-real-code": "code-cell-routing",
	"eval-stay-direct": "code-cell-routing",
};

const PRESET_DIALECT: ReadonlyArray<readonly [PromptPresetName, ExecutionToolingDialect]> = [
	["claude-fable-5-1", "claude"],
	["claude-fable-5", "claude"],
	["claude-opus-5", "claude"],
	["claude-opus-4-8", "claude"],
	["claude-opus-4-7", "claude"],
	["claude-opus-4-6", "claude"],
	["claude-opus-4-5", "claude"],
	["kimi-k3", "kimi"],
	["kimi-k2-7", "kimi"],
	["kimi-k2-6", "kimi"],
	["glm-5.3", "claude"],
	["glm-5.2", "claude"],
];

const OUT_OF_SCOPE: readonly PromptPresetName[] = ["gpt-5.5", "grok-4.6", "deepseek-v4-flash"];

const evalRules = () => EXECUTION_TOOLING_RULES.filter((rule) => rule.concern === "code-cell-routing");

describe("execution tooling directive", () => {
	it("models the directives as parsed rule data with one wording per dialect", () => {
		// given
		const rulesById = new Map(EXECUTION_TOOLING_RULES.map((rule) => [rule.id, rule]));

		// then
		expect([...rulesById.keys()].sort()).toEqual(Object.keys(EXPECTED_CONCERN).sort());
		for (const [id, concern] of Object.entries(EXPECTED_CONCERN)) {
			expect(rulesById.get(id as ExecutionToolingRuleId)?.concern).toBe(concern);
		}
		for (const rule of EXECUTION_TOOLING_RULES) {
			for (const dialect of ["claude", "kimi"] as const) {
				expect(rule.directive[dialect].length).toBeGreaterThan(32);
				expect(rule.directive[dialect]).not.toMatch(/\p{Extended_Pictographic}/u);
			}
			expect(rule.directive.kimi).not.toMatch(/\bNEVER\b/);
		}
	});

	it.each(PRESET_DIALECT)("renders every %s directive exactly once when eval is selected", (presetName, dialect) => {
		// given
		const prompt = buildPrompt(presetName, ["eval", "monitor", "read", "bash"]);

		// then
		for (const rule of EXECUTION_TOOLING_RULES) {
			expect(occurrences(prompt, rule.directive[dialect]), rule.id).toBe(1);
		}
	});

	it.each(PRESET_DIALECT)("renders nothing for %s when eval is not selected", (presetName, dialect) => {
		// given
		const prompt = buildPrompt(presetName, ["read", "bash"]);

		// then
		for (const rule of EXECUTION_TOOLING_RULES) {
			expect(prompt, rule.id).not.toContain(rule.directive[dialect]);
		}
	});

	it.each(PRESET_DIALECT)("gates %s eval rules on eval alone, never on monitor", (presetName, dialect) => {
		// given
		const evalSelected = buildPrompt(presetName, ["eval", "read"]);
		const monitorOnly = buildPrompt(presetName, ["monitor", "bash"]);

		// then
		for (const rule of evalRules()) {
			expect(occurrences(evalSelected, rule.directive[dialect]), rule.id).toBe(1);
			expect(monitorOnly, rule.id).not.toContain(rule.directive[dialect]);
		}
	});

	it("leaves the wait-as-subscription stance to the eval tool description", () => {
		// given
		const ids = EXECUTION_TOOLING_RULES.map((rule) => rule.id);

		// then
		expect(ids).not.toContain("monitor-subscribe");
		for (const rule of EXECUTION_TOOLING_RULES) {
			for (const dialect of ["claude", "kimi"] as const) {
				expect(rule.directive[dialect], rule.id).not.toMatch(/register `?monitor`?/i);
			}
		}
	});

	it.each(OUT_OF_SCOPE)("keeps the directive out of %s", (presetName) => {
		// given
		const prompt = buildPrompt(presetName, ["eval", "monitor", "read", "bash"]);

		// then
		for (const rule of EXECUTION_TOOLING_RULES) {
			for (const dialect of ["claude", "kimi"] as const) {
				expect(prompt, `${rule.id}/${dialect}`).not.toContain(rule.directive[dialect]);
			}
		}
	});
});
