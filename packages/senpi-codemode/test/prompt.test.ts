import { describe, expect, it } from "vitest";
import { buildEvalPrompt, evalEmphasisStyle } from "../src/prompt/eval-prompt.ts";

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
		// Given: prompts exposing the Python example set and kernels without one.
		const python = buildEvalPrompt({ py: true, js: false, rb: false, jl: false }, { spawns: false }).description;
		const ruby = buildEvalPrompt({ py: false, js: false, rb: true, jl: false }, { spawns: false }).description;
		const node = buildEvalPrompt({ py: false, js: true, rb: false, jl: false }, { spawns: false }).description;

		// When: their embedded reuse-chain examples are rendered.
		// Then: only Python kernels carry examples, and those teach batch + tool bridging.
		expect(python).toContain("collect targets");
		expect(python).toContain("tool.grep");
		expect(python).toContain("parallel([");
		expect(ruby).not.toContain("<examples>");
		expect(node).not.toContain("<examples>");
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
		// Given: a registered eval tool with no active model id.
		// When: its prompt metadata is built.
		const guidelines = buildEvalPrompt({ py: true, js: true, rb: true, jl: true }, { spawns: true }).promptGuidelines;

		// Then: the system-prompt guidance carries the maximum-emphasis batching contract.
		expect(guidelines).toEqual([
			"**EVAL FIRST.** Any step needing MORE THAN ONE tool call MUST be ONE eval cell: run independent calls in parallel, wrap risky calls in try/except, and return distilled facts — NEVER a chain of single tool calls.",
			"Use eval reset only when a language kernel must be wiped; reset is scoped to the selected language.",
		]);
	});

	it("maps model ids to emphasis dialects across provider id shapes", () => {
		// Given: model ids as they appear across bundled provider catalogs.
		// When/Then: each id resolves to its family dialect; unknown ids fall back to default.
		const claudeIds = [
			"claude-opus-4-8",
			"anthropic/claude-fable-5",
			"eu.anthropic.claude-sonnet-5",
			"glm-5.2",
			"@cf/zai-org/glm-4.7-flash",
			"accounts/fireworks/models/glm-5p2",
		];
		const kimiIds = ["kimi-k2.6", "@cf/moonshotai/kimi-k2.7-code", "accounts/fireworks/models/kimi-k2p6"];
		const codexIds = ["gpt-5.6", "gpt-5.2-codex", "o3-mini", "@cf/openai/gpt-oss-120b", "codex-mini-latest"];
		const defaultIds = ["gemini-2.5-flash", "deepseek-chat", "qwen3-coder", "minimax-m2.5"];
		for (const id of claudeIds) expect(evalEmphasisStyle(id), id).toBe("claude");
		for (const id of kimiIds) expect(evalEmphasisStyle(id), id).toBe("kimi");
		for (const id of codexIds) expect(evalEmphasisStyle(id), id).toBe("codex");
		for (const id of defaultIds) expect(evalEmphasisStyle(id), id).toBe("default");
		expect(evalEmphasisStyle(undefined)).toBe("default");
	});

	it("renders exactly one batching dialect selected by the model id", () => {
		// Given: the same kernel set rendered for each model family.
		const enabled = { py: true, js: true, rb: false, jl: false };
		const render = (modelId?: string): string =>
			buildEvalPrompt(enabled, modelId === undefined ? { spawns: false } : { spawns: false, modelId }).description;

		// When: the descriptions are built.
		const claude = render("claude-opus-4-8");
		const codex = render("gpt-5.6");
		const kimi = render("kimi-k2.6");
		const fallback = render();

		// Then: each carries only its own dialect marker.
		expect(claude).toContain("<eval_first_batching>");
		expect(claude).toContain("your default execution surface");
		expect(claude).not.toContain("EVAL IS YOUR PRIMARY EXECUTION SURFACE");
		expect(codex).toContain("Route multi-call steps through eval");
		expect(codex).not.toContain("<eval_first_batching>");
		expect(codex).not.toContain("EVAL IS YOUR PRIMARY EXECUTION SURFACE");
		const kimiInstruction = kimi.slice(0, kimi.indexOf("<prelude>"));
		expect(kimiInstruction).toContain("Treat eval as the standard way to execute");
		expect(kimiInstruction).not.toContain("NEVER kills the batch");
		expect(kimiInstruction).not.toContain("<eval_first_batching>");
		expect(fallback).toContain("EVAL IS YOUR PRIMARY EXECUTION SURFACE");
		expect(fallback).toContain("parallel(thunks)");
	});

	it("tunes the batching guideline to the model dialect", () => {
		// Given: the same kernel set with model ids from each family.
		const enabled = { py: true, js: true, rb: true, jl: true };
		const guideline = (modelId: string): string =>
			buildEvalPrompt(enabled, { spawns: false, modelId }).promptGuidelines[0];

		// When/Then: the first guideline is the family-tuned batching contract.
		expect(guideline("claude-opus-4-8")).toBe(
			"Prefer eval for any step needing more than one tool call: one cell that runs independent calls in parallel, handles per-call failures in code, and returns distilled facts.",
		);
		expect(guideline("gpt-5.6")).toBe(
			"Route multi-call steps through eval: one cell per step, independent calls dispatched in parallel; fall back to direct tool calls when one call is sufficient or each result changes the next decision.",
		);
		expect(guideline("kimi-k2.6")).toBe(
			"Treat eval as the standard way to execute multi-call steps: one cell that runs independent calls in parallel, handles failures per item, and returns distilled facts.",
		);
	});

	it("renders the host-sizing note only when a host line is provided", () => {
		// Given: the same kernel set with and without a preformatted host line.
		const enabled = { py: true, js: true, rb: false, jl: false };
		const withHost = buildEvalPrompt(enabled, {
			spawns: false,
			hostLine: "darwin arm64 \u00b7 Apple M5 Max \u00b7 18 cores",
		}).description;
		const withoutHost = buildEvalPrompt(enabled, { spawns: false }).description;

		// Then: the note names the host and the sizing rule, and disappears without one.
		expect(withHost).toContain("Host: darwin arm64 \u00b7 Apple M5 Max \u00b7 18 cores — cells execute here.");
		expect(withHost).toContain("Size `parallel(thunks)` pools to its cores");
		expect(withoutHost).not.toContain("Host:");
	});

	it("throws when no kernels are enabled", () => {
		expect(() => buildEvalPrompt({ py: false, js: false, rb: false, jl: false })).toThrow(/no kernels enabled/i);
	});
});
