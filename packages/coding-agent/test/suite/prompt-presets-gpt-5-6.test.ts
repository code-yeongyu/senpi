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

function buildPrompt(
	presetName: PromptPresetName,
	modelId: string,
	selectedTools: readonly string[] = ["eval", "monitor", "read", "bash", "apply_patch"],
): string {
	const settings: PromptPresetSettings = { promptPreset: presetName };
	const preset = resolvePreset(createModel(modelId), settings, {
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

const EXPECTED_CONCERN: Record<Gpt56ExecutionRuleId, Gpt56ExecutionConcern> = {
	"eval-first-routing": "tool-orchestration",
	"evidence-comparison": "tool-orchestration",
	"perceived-state-loop": "tool-orchestration",
	"stay-direct-exceptions": "tool-orchestration",
	delegation: "delegation",
	"todo-granularity": "todo-discipline",
	"test-decision": "tests",
	"atomic-commits": "commit-discipline",
	"lsp-symbol-routing": "symbol-routing",
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
		const orchestration = GPT56_EXECUTION_RULES.filter((rule) => rule.concern === "tool-orchestration");
		expect(orchestration.length).toBe(4);
	});

	it("leaves the wait-as-subscription stance to the eval tool description", () => {
		// then
		expect(GPT56_EXECUTION_RULES.map((rule) => rule.id)).not.toContain("monitor-subscribe");
	});

	it("keeps the shared GPT code-execution routing bridge at the orchestration point of use", () => {
		// given
		const prompt = buildPrompt("gpt-5.6", "gpt-5.6-terra");
		const bridge = buildGptEvalRoutingTuning();

		// then
		expect(occurrences(prompt, bridge)).toBe(1);
	});

	it("routes a narrow question through request_user_input when it is available", () => {
		const prompt = buildPrompt("gpt-5.6", "gpt-5.6-sol");

		expect(prompt).toContain("request_user_input");
	});

	it("renders the apply_patch file-operations tuning for the luna variant", () => {
		// given
		const prompt = buildPrompt("gpt-5.6", "gpt-5.6-luna");

		// then
		expect(prompt).toContain("apply_patch");
	});
});
