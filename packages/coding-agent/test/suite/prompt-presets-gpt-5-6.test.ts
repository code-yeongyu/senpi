import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	GPT56_EXECUTION_RULES,
	type Gpt56ExecutionConcern,
	type Gpt56ExecutionRuleId,
} from "../../src/core/extensions/builtin/prompt-preset/gpt-5.6.ts";
import { buildGptEvalRoutingTuning } from "../../src/core/extensions/builtin/prompt-preset/gpt-eval-routing.ts";
import { type PromptPresetSettings, resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import type { PromptPresetName } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";

function createModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

function buildPrompt(presetName: PromptPresetName, modelId: string): string {
	const settings: PromptPresetSettings = { promptPreset: presetName };
	const preset = resolvePreset(createModel(modelId), settings, {
		cwd: "/repo",
		selectedTools: ["eval", "read", "bash"],
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

const EXPECTED_CONCERN: Record<Gpt56ExecutionRuleId, Gpt56ExecutionConcern> = {
	"eval-first-routing": "tool-orchestration",
	"parallel-batching": "tool-orchestration",
	"over-call-bias": "tool-orchestration",
	"in-kernel-reduction": "tool-orchestration",
	"stay-direct-exceptions": "tool-orchestration",
	delegation: "delegation",
	"todo-granularity": "todo-discipline",
	"test-first": "test-first",
	"atomic-commits": "commit-discipline",
	"lsp-symbol-routing": "symbol-routing",
};

const EXPECTED_SECTION: Record<Gpt56ExecutionRuleId, string> = {
	"eval-first-routing": "Working the Task",
	"parallel-batching": "Working the Task",
	"over-call-bias": "Working the Task",
	"in-kernel-reduction": "Working the Task",
	"stay-direct-exceptions": "Working the Task",
	delegation: "Working the Task",
	"todo-granularity": "Working the Task",
	"lsp-symbol-routing": "Working the Task",
	"test-first": "Pragmatism & Scope",
	"atomic-commits": "Hard Limits",
};

describe("GPT-5.6 execution discipline", () => {
	it("models the execution directives as parsed rule data instead of prompt snapshots", () => {
		// given
		const rulesById = new Map(GPT56_EXECUTION_RULES.map((rule) => [rule.id, rule]));

		// then
		expect([...rulesById.keys()].sort()).toEqual(Object.keys(EXPECTED_CONCERN).sort());
		for (const [id, concern] of Object.entries(EXPECTED_CONCERN)) {
			expect(rulesById.get(id as Gpt56ExecutionRuleId)?.concern).toBe(concern);
		}
		for (const rule of GPT56_EXECUTION_RULES) {
			expect(rule.directive.length).toBeGreaterThan(32);
			expect(rule.directive).not.toMatch(/\p{Extended_Pictographic}/u);
		}
		const orchestration = GPT56_EXECUTION_RULES.filter((rule) => rule.concern === "tool-orchestration");
		expect(orchestration.length).toBeGreaterThanOrEqual(5);
	});

	it("renders every directive exactly once, at its point of use in the core", () => {
		// given
		const prompt = buildPrompt("gpt-5.6", "gpt-5.6-sol");
		const sections = sectionsOf(prompt);

		// then
		for (const rule of GPT56_EXECUTION_RULES) {
			expect(occurrences(prompt, rule.directive)).toBe(1);
			const section = sections.get(EXPECTED_SECTION[rule.id]);
			expect(section, `missing section for ${rule.id}`).toBeDefined();
			expect(section).toContain(rule.directive);
		}
	});

	it("keeps the shared GPT code-execution routing bridge at the orchestration point of use", () => {
		// given
		const prompt = buildPrompt("gpt-5.6", "gpt-5.6-terra");
		const sections = sectionsOf(prompt);
		const bridge = buildGptEvalRoutingTuning();

		// then
		expect(occurrences(prompt, bridge)).toBe(1);
		expect(sections.get("Working the Task")).toContain(bridge);
	});

	it("drops the anti-test default that contradicts the test-first directive", () => {
		// given
		const prompt = buildPrompt("gpt-5.6", "gpt-5.6-luna");

		// then
		expect(prompt).not.toContain("Default to not adding tests");
		expect(prompt).toContain("apply_patch");
	});

	it("preserves the dieted core's own sections", () => {
		// given
		const headings = [...sectionsOf(buildPrompt("gpt-5.6", "gpt-5.6")).keys()];

		// then
		expect(headings).toEqual(
			expect.arrayContaining([
				"Intent Gate",
				"Working the Task",
				"Verification",
				"Manual QA Gate",
				"Failure Recovery",
				"Pragmatism & Scope",
				"Hard Limits",
				"Output",
				"Stop Goal",
			]),
		);
	});

	it.each(["gpt-5.5", "grok-4.5"] as const)("keeps the GPT-5.6 execution contract out of %s", (presetName) => {
		// given
		const prompt = buildPrompt(presetName, presetName);

		// then
		for (const rule of GPT56_EXECUTION_RULES) {
			expect(prompt).not.toContain(rule.directive);
		}
	});
});
