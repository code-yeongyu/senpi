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
		expect(withoutSpawns).not.toContain("<workflow>");
		expect(withSpawns).toContain('agent(prompt, agent?="researcher"');
		expect(withSpawns).toContain('output(*ids, format?="raw"');
		expect(withSpawns).toContain("<workflow>");
		expect(withSpawns).toContain("omit it to use `researcher`");
	});

	it("documents core helpers with Node wording and no excluded surface when no js runtime is given", () => {
		const prompt = fullPrompt({ py: true, js: true, rb: true, jl: true });

		for (const helperName of coreHelperNames) {
			expect(prompt).toContain(helperName);
		}
		expect(prompt).toContain("Node.js worker");
		for (const token of forbiddenPromptTokens) {
			expect(prompt).not.toContain(token);
		}
	});

	it("documents timeout detachment, busy-kernel discipline, and detached-cell controls", () => {
		const prompt = fullPrompt({ py: true, js: true, rb: false, jl: false });

		expect(prompt).toContain("`on_timeout`");
		expect(prompt).toContain('eval({ action: "peek", cell_id })');
		expect(prompt).toContain('eval({ action: "stop", cell_id })');
		expect(prompt).toContain("Do not re-run a detached cell");
	});

	it("teaches output() as an immediate status or transcript read", () => {
		const prompt = fullPrompt({ py: true, js: true, rb: false, jl: false }, { spawns: true });

		expect(prompt).toContain("Reads immediately: running tasks return their status");
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
		const gptIds = ["gpt-5.6", "gpt-5.2-codex", "@cf/openai/gpt-oss-120b"];
		const codexIds = ["o3-mini", "codex-mini-latest"];
		const defaultIds = ["gemini-2.5-flash", "deepseek-chat", "qwen3-coder", "minimax-m2.5"];
		for (const id of claudeIds) expect(evalEmphasisStyle(id), id).toBe("claude");
		for (const id of kimiIds) expect(evalEmphasisStyle(id), id).toBe("kimi");
		for (const id of gptIds) expect(evalEmphasisStyle(id), id).toBe("gpt");
		for (const id of codexIds) expect(evalEmphasisStyle(id), id).toBe("codex");
		for (const id of defaultIds) expect(evalEmphasisStyle(id), id).toBe("default");
		expect(evalEmphasisStyle(undefined)).toBe("default");
	});

	it("gates the monitor subscription stance on monitor availability in every dialect", () => {
		// Given: each eval emphasis dialect with and without the reachable monitor tool.
		const enabled = { py: true, js: true, rb: false, jl: false };
		const dialects = [undefined, "claude-opus-4-8", "gpt-5.6", "o3-mini", "kimi-k2.6"] as const;
		const render = (modelId: (typeof dialects)[number], monitor?: boolean): string => {
			const options: { spawns: boolean; modelId?: string; monitor?: boolean } = {
				spawns: false,
				...(modelId === undefined ? {} : { modelId }),
				...(monitor === undefined ? {} : { monitor }),
			};
			return buildEvalPrompt(enabled, options).description;
		};

		// When: the prompt is built with the registry-gated monitor capability.
		for (const modelId of dialects) {
			const withMonitor = render(modelId, true);
			expect(withMonitor.match(/tool\.monitor\(/g) ?? [], `model=${modelId ?? "default"}`).toHaveLength(1);
			expect(withMonitor, `model=${modelId ?? "default"}`).toContain("event wakes the turn");
		}

		// Then: unavailable monitor capability leaves no unreachable call or stance behind.
		for (const modelId of dialects) {
			for (const monitor of [false, undefined]) {
				const withoutMonitor = render(modelId, monitor);
				expect(withoutMonitor, `model=${modelId ?? "default"}, monitor=${monitor ?? "omitted"}`).not.toContain(
					"tool.monitor(",
				);
				expect(withoutMonitor, `model=${modelId ?? "default"}, monitor=${monitor ?? "omitted"}`).not.toContain(
					"event wakes the turn",
				);
			}
		}
	});

	it("shows each enabled language its correctly-formed handle option, never a fused dialect", () => {
		// Given: spawn-enabled prompts across kernel combinations.
		const cases: Array<[{ py: boolean; js: boolean; rb: boolean; jl: boolean }, string[]]> = [
			[{ py: false, js: true, rb: false, jl: false }, ["{ handle: true }"]],
			[{ py: true, js: false, rb: false, jl: false }, ["handle=True"]],
			[{ py: true, js: true, rb: false, jl: false }, ["handle=True", "{ handle: true }"]],
		];

		for (const [enabled, expectedForms] of cases) {
			const prompt = buildEvalPrompt(enabled, { spawns: true }).description;

			// Then: each enabled language's form is present and the two are never fused without a separator.
			expect(prompt).not.toContain("handle=True{ handle: true }");
			expect(prompt).not.toContain("True{");
			for (const form of expectedForms) expect(prompt).toContain(form);
			if (enabled.js) expect(prompt).not.toContain("`handle=True``{ handle: true }`");
		}
	});

	it("renders exactly one batching dialect selected by the model id", () => {
		// Given: the same kernel set rendered for each model family.
		const enabled = { py: true, js: true, rb: false, jl: false };
		const render = (modelId?: string): string =>
			buildEvalPrompt(enabled, modelId === undefined ? { spawns: false } : { spawns: false, modelId }).description;

		// When: the descriptions are built.
		const claude = render("claude-opus-4-8");
		const gpt = render("gpt-5.6");
		const kimi = render("kimi-k2.6");
		const fallback = render();

		// Then: each carries only its own dialect marker.
		expect(claude).toContain("<eval_first_batching>");
		expect(claude).toContain("your default execution surface");
		expect(claude).not.toContain("EVAL IS YOUR PRIMARY EXECUTION SURFACE");
		expect(gpt).toContain("<gpt_eval_dialect>");
		expect(gpt).toContain("detach on timeout");
		expect(gpt).not.toContain("<eval_first_batching>");
		expect(gpt).not.toContain("EVAL IS YOUR PRIMARY EXECUTION SURFACE");
		const kimiInstruction = kimi.slice(0, kimi.indexOf("<prelude>"));
		expect(kimiInstruction).toContain("EVAL IS YOUR SUPERPOWER");
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
			"Use eval to compose tool work in one cell; long cells detach on timeout and notify on completion, so do not poll.",
		);
		expect(guideline("kimi-k2.6")).toBe(
			"**EVAL IS YOUR SUPERPOWER — DEFAULT TO IT.** Execute EVERY multi-call step as ONE eval cell: run ALL independent calls simultaneously via parallel(thunks), handle failures per item in code, and return ONLY distilled facts.",
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

	it("describes the Bun kernel and names the bun-1-4 skill as MUST READ only while it is active", () => {
		// Given: the same kernel set under a bun kernel with the skill, a bun kernel without it, and a node kernel.
		const enabled = { py: true, js: true, rb: false, jl: false };
		const bunSkillPath = "/opt/senpi/skill/bun-1-4/SKILL.md";
		const bunWithSkill = buildEvalPrompt(enabled, {
			spawns: false,
			jsRuntime: { name: "bun", version: "1.4.0", path: "/usr/local/bin/bun" },
			bunSkillPath,
		}).description;
		const bunWithoutSkill = buildEvalPrompt(enabled, {
			spawns: false,
			jsRuntime: { name: "bun", version: "1.3.9", path: "/usr/local/bin/bun" },
		}).description;
		const node = buildEvalPrompt(enabled, {
			spawns: false,
			jsRuntime: { name: "node", version: "26.7.0", path: "/usr/local/bin/node" },
			bunSkillPath,
		}).description;
		const jsDisabled = buildEvalPrompt(
			{ py: true, js: false, rb: false, jl: false },
			{ spawns: false, jsRuntime: { name: "bun", version: "1.4.0" }, bunSkillPath },
		).description;

		// Then: only the bun kernel with an active skill carries the pointer; node keeps its wording.
		expect(bunWithSkill).toContain("JS runs in-process on Bun 1.4.0");
		expect(bunWithSkill).toContain(`MUST READ the bun-1-4 skill at ${bunSkillPath} before your first js cell`);
		expect(bunWithSkill).not.toContain("Node.js worker");
		expect(bunWithoutSkill).toContain("JS runs in-process on Bun 1.3.9");
		expect(bunWithoutSkill).not.toContain("MUST READ");
		expect(node).toContain("Node.js worker");
		expect(node).not.toContain("MUST READ");
		expect(node).not.toContain(bunSkillPath);
		expect(jsDisabled).not.toContain("Bun");
		expect(jsDisabled).not.toContain(bunSkillPath);
	});

	it("throws when no kernels are enabled", () => {
		expect(() => buildEvalPrompt({ py: false, js: false, rb: false, jl: false })).toThrow(/no kernels enabled/i);
	});
});
