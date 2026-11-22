import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { presetSharedSections } from "../../src/core/extensions/builtin/prompt-preset/contract.ts";
import {
	buildExecutionToolingSection,
	EXECUTION_TOOLING_RULES,
	type ExecutionToolingConcern,
	type ExecutionToolingDialect,
	type ExecutionToolingRule,
	type ExecutionToolingRuleId,
	renderExecutionToolingDirective,
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

/** The wording `presetName` renders for `toolNames`: the full shared-section presets keep the pre-diet directive (senpi#5665). */
function directiveFor(
	rule: ExecutionToolingRule,
	presetName: PromptPresetName,
	dialect: ExecutionToolingDialect,
	toolNames: readonly string[],
): string {
	const sharedSections = presetName === "auto" ? "diet" : presetSharedSections(presetName);
	return renderExecutionToolingDirective(rule, { toolNames, dialect, sharedSections });
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
	"eval-routing-decision": "code-cell-routing",
	"eval-evidence-return": "code-cell-routing",
	"perceived-state-loop": "code-cell-routing",
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
	["kimi-k3-1", "kimi"],
	["kimi-k3", "kimi"],
	["kimi-k2-8", "kimi"],
	["kimi-k2-7", "kimi"],
	["kimi-k2-6", "kimi"],
	["glm-5.3", "claude"],
	["glm-5.2", "claude"],
];

const OUT_OF_SCOPE: readonly PromptPresetName[] = ["gpt-5.5", "grok-4.6", "deepseek-v4-flash"];

const evalRules = () => EXECUTION_TOOLING_RULES.filter((rule) => rule.concern === "code-cell-routing");

const FILE_EDITING_TOOLS = ["edit", "write", "apply_patch"];

/** Session tools -> the file-editing tools the section must name (senpi#7275 review findings). */
const EDIT_TOOL_PROFILES: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
	["eval + edit + write", ["eval", "edit", "write"], ["edit", "write"]],
	["eval + apply_patch", ["eval", "apply_patch"], ["apply_patch"]],
	["eval + write", ["eval", "write"], ["write"]],
	["eval only", ["eval"], []],
];

const backtickedTokens = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(([, token = ""]) => token);

const DIALECT_WORDINGS = [
	["claude", "diet"],
	["claude", "full"],
	["kimi", "diet"],
	["kimi", "full"],
] as const;

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
			expect(rule.directive.kimi, `${rule.id} kimi dialect shouts`).not.toMatch(/\b[A-Z]{4,}\b/);
		}
	});

	it.each(PRESET_DIALECT)("renders every %s directive exactly once when eval is selected", (presetName, dialect) => {
		// given
		const tools = ["eval", "monitor", "read", "bash", "edit", "write"];
		const prompt = buildPrompt(presetName, tools);

		// then
		for (const rule of EXECUTION_TOOLING_RULES) {
			expect(occurrences(prompt, directiveFor(rule, presetName, dialect, tools)), rule.id).toBe(1);
		}
	});

	it.each(PRESET_DIALECT)("renders nothing for %s when eval is not selected", (presetName, dialect) => {
		// given
		const tools = ["read", "bash"];
		const prompt = buildPrompt(presetName, tools);

		// then
		for (const rule of EXECUTION_TOOLING_RULES) {
			expect(prompt, rule.id).not.toContain(directiveFor(rule, presetName, dialect, [...tools, "eval"]));
		}
	});

	it.each(PRESET_DIALECT)("gates %s eval rules on eval alone, never on monitor", (presetName, dialect) => {
		// given
		const evalSelected = buildPrompt(presetName, ["eval", "read"]);
		const monitorOnly = buildPrompt(presetName, ["monitor", "bash"]);

		// then
		for (const rule of evalRules()) {
			expect(occurrences(evalSelected, directiveFor(rule, presetName, dialect, ["eval", "read"])), rule.id).toBe(1);
			expect(monitorOnly, rule.id).not.toContain(
				directiveFor(rule, presetName, dialect, ["eval", "monitor", "bash"]),
			);
		}
	});

	it.each(EDIT_TOOL_PROFILES)("names exactly the offered editing tools for %s", (_profile, toolNames, editTools) => {
		for (const [dialect, sharedSections] of DIALECT_WORDINGS) {
			// given
			const options = { toolNames, dialect, sharedSections };
			const tokens = backtickedTokens(buildExecutionToolingSection(options));
			const editToolsIn = (id: ExecutionToolingRuleId): string[] => {
				const rule = EXECUTION_TOOLING_RULES.find((candidate) => candidate.id === id);
				const ruleTokens = rule ? backtickedTokens(renderExecutionToolingDirective(rule, options)) : [];
				return FILE_EDITING_TOOLS.filter((name) => ruleTokens.includes(name));
			};

			// then
			const wording = `${dialect}/${sharedSections}`;
			expect(editToolsIn("eval-routing-decision"), `${wording} routing`).toEqual(editTools);
			expect(editToolsIn("eval-stay-direct"), `${wording} stay-direct`).toEqual(editTools);
			expect(
				FILE_EDITING_TOOLS.filter((name) => tokens.includes(name)),
				wording,
			).toEqual(editTools);
			expect([...new Set(tokens.filter((token) => !toolNames.includes(token)))], wording).toEqual([
				"parallel(thunks)",
			]);
		}
	});

	it("renders no section, and so no tool name, when eval is not offered", () => {
		for (const [dialect, sharedSections] of DIALECT_WORDINGS) {
			expect(buildExecutionToolingSection({ toolNames: FILE_EDITING_TOOLS, dialect, sharedSections })).toBe("");
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
		const toolNames = ["eval", "monitor", "read", "bash"];
		const prompt = buildPrompt(presetName, toolNames);

		// then
		for (const rule of EXECUTION_TOOLING_RULES) {
			for (const dialect of ["claude", "kimi"] as const) {
				expect(prompt, `${rule.id}/${dialect}`).not.toContain(
					renderExecutionToolingDirective(rule, { toolNames, dialect }),
				);
			}
		}
	});
});
