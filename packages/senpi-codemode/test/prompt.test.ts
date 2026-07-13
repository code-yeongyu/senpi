import { describe, expect, it } from "vitest";
import { buildEvalPrompt } from "../src/prompt/eval-prompt.ts";

type PromptOptions = {
	readonly spawns: boolean;
	readonly spawnDefaultAgent?: string;
};

const forbiddenPromptTokens = ["budget", "+Nk", "PI_", "artifact://", "Bun"] as const;
const coreHelperNames = [
	"display(value)",
	"print(value",
	"read(path",
	"write(path",
	"env(key",
	"tool.<name>(args)",
	"completion(prompt",
	"parallel(thunks)",
	"pipeline(items",
	"log(message)",
	"phase(title)",
] as const;

function fullPrompt(
	enabled: {
		readonly py: boolean;
		readonly js: boolean;
		readonly rb: boolean;
		readonly jl: boolean;
	},
	options: PromptOptions = { spawns: false },
): string {
	const prompt = buildEvalPrompt(enabled, options);
	return [prompt.description, prompt.promptSnippet ?? "", ...prompt.promptGuidelines].join("\n");
}

describe("buildEvalPrompt", () => {
	it.each([
		["js without spawns", { py: false, js: true, rb: false, jl: false }, { spawns: false }],
		["js-py without spawns", { py: true, js: true, rb: false, jl: false }, { spawns: false }],
		["all with spawns", { py: true, js: true, rb: true, jl: true }, { spawns: true, spawnDefaultAgent: "task" }],
	] as const)("renders the %s prompt", (_name, enabled, options) => {
		// Given: an enabled language set and its task-tool availability.
		// When: the eval prompt is built.
		// Then: its complete user-facing contract remains snapshotted.
		expect(buildEvalPrompt(enabled, options)).toMatchSnapshot();
	});

	it("documents only enabled language fields and reset scope", () => {
		const prompt = fullPrompt({ py: true, js: true, rb: false, jl: false });

		expect(prompt).toContain('`"py"` IPython kernel');
		expect(prompt).toContain('`"js"` persistent JavaScript VM');
		expect(prompt).not.toContain('`"rb"` persistent Ruby kernel');
		expect(prompt).not.toContain('`"jl"` persistent Julia kernel');
		expect(prompt).toContain("a `py` reset never touches the JS VM");
	});

	it("omits disabled and missing languages from the prompt", () => {
		const prompt = fullPrompt({ py: false, js: true, rb: false, jl: false });

		expect(prompt).toContain('`"js"` persistent JavaScript VM');
		expect(prompt).not.toContain('`"py"` IPython kernel');
		expect(prompt).not.toContain('`"rb"` persistent Ruby kernel');
		expect(prompt).not.toContain('`"jl"` persistent Julia kernel');
	});

	it("gates spawn helpers and the DAG on task-tool availability", () => {
		// Given: the same Python/Node kernel pair with and without a task tool.
		const enabled = { py: true, js: true, rb: false, jl: false };
		// When: the descriptions are built for both availability states.
		const withoutSpawns = buildEvalPrompt(enabled, { spawns: false }).description;
		const withSpawns = buildEvalPrompt(enabled, { spawns: true, spawnDefaultAgent: "researcher" }).description;

		// Then: task-only helpers and the DAG are exposed only when callable.
		expect(withoutSpawns).not.toContain("agent(");
		expect(withoutSpawns).not.toContain("output(*ids");
		expect(withoutSpawns).not.toContain("<dag>");
		expect(withSpawns).toContain('agent(prompt, agent?="researcher"');
		expect(withSpawns).toContain('output(*ids, format?="raw"');
		expect(withSpawns).toContain("<dag>");
		expect(withSpawns).toContain("omit it to use `researcher`");
	});

	it("filters reuse-chain examples by enabled language", () => {
		// Given: prompts that each expose one language from the upstream example set.
		const python = buildEvalPrompt({ py: true, js: false, rb: false, jl: false }, { spawns: false }).description;
		const ruby = buildEvalPrompt({ py: false, js: false, rb: true, jl: false }, { spawns: false }).description;
		const node = buildEvalPrompt({ py: false, js: true, rb: false, jl: false }, { spawns: false }).description;

		// When: their embedded reuse-chain examples are rendered.
		// Then: each prompt contains only examples its kernels can execute.
		expect(python).toContain("import json");
		expect(python).not.toContain("require ");
		expect(ruby).toContain("require ");
		expect(ruby).not.toContain("import json");
		expect(node).not.toContain("require ");
		expect(node).not.toContain("import json");
	});

	it("documents core helpers with Node wording and no excluded surface", () => {
		const prompt = fullPrompt({ py: true, js: true, rb: true, jl: true });

		for (const helperName of coreHelperNames) {
			expect(prompt).toContain(helperName);
		}
		expect(prompt).toContain("Node.js worker");
		for (const token of forbiddenPromptTokens) {
			expect(prompt).not.toContain(token);
		}
	});

	it("keeps eval-specific prompt guidelines stable", () => {
		// Given: a registered eval tool.
		// When: its prompt metadata is built.
		const guidelines = buildEvalPrompt({ py: true, js: true, rb: true, jl: true }, { spawns: true }).promptGuidelines;

		// Then: the system-prompt guidance remains the eval contract.
		expect(guidelines).toEqual([
			"Use eval for incremental code execution when a persistent JS, Python, Ruby, or Julia kernel is available.",
			"Use eval reset only when a language kernel must be wiped; reset is scoped to the selected language.",
		]);
	});

	it("throws when no kernels are enabled", () => {
		expect(() => buildEvalPrompt({ py: false, js: false, rb: false, jl: false })).toThrow(/no kernels enabled/i);
	});
});
