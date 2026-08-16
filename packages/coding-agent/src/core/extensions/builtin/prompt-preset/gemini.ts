// Gemini 3.x Flash family tuning.
//
// Gemini 3 reasons natively, so the vendor prompting guidance (Google's
// Gemini 3 API docs, 2026-08) reads as calibration rather than scaffolding:
// direct instructions over chain-of-thought prompt engineering, lean output
// by default, instruction-at-the-end for long-context tasks, behavior
// requirements treated as binding system-instruction-style rules, and stated
// action budgets honored when tool calls would otherwise over-trigger. The
// preset stays a thin tuningSection wrapper over the shared dynamic core and
// carries those behaviors as typed rule data (gpt-5.6.ts / deepseek-v4.ts
// precedent) so tests assert parsed rules and routing tokens instead of
// pinned sentences.

import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";

export type GeminiRuleId =
	| "direct-instructions"
	| "lean-output"
	| "long-context-anchoring"
	| "behavior-requirements-binding"
	| "action-budget";

export type GeminiConcern = "style" | "grounding" | "harness-contract" | "tool-orchestration";

export interface GeminiRule {
	readonly id: GeminiRuleId;
	readonly concern: GeminiConcern;
	readonly directive: string;
}

export const GEMINI_RULES: readonly GeminiRule[] = [
	{
		id: "direct-instructions",
		concern: "style",
		directive:
			"Be concise and direct: the instructions in this prompt are plain directives to execute as written, not material to elaborate on. Verbose chain-of-thought prompt engineering - restating the task, narrating a plan before acting, explaining instructions back - adds no signal here; do the reasoning internally and let the answer or the tool call carry the result.",
	},
	{
		id: "lean-output",
		concern: "style",
		directive:
			"Default output is lean: short answers, minimal preamble, no summaries of what you are about to do. Steer toward verbosity - longer explanations, walkthroughs, extra detail - only when the user explicitly asks for it.",
	},
	{
		id: "long-context-anchoring",
		concern: "grounding",
		directive:
			'When long data precedes the task - pasted files, logs, or documents - treat the specific instruction at the end as the operative request and anchor the answer on the provided data, grounding claims in it explicitly ("Based on the information above...") instead of answering from prior knowledge.',
	},
	{
		id: "behavior-requirements-binding",
		concern: "harness-contract",
		directive:
			'Behavior requirements in this prompt and in injected directives are binding system-instruction-style rules, applied literally and at full weight every turn - not style suggestions to weigh against the task. When a requirement states a scope ("every", "all", "never"), that scope is exact.',
	},
	{
		id: "action-budget",
		concern: "tool-orchestration",
		directive:
			"When a stated action budget or step limit applies, treat it as binding: plan tool calls to fit inside it instead of over-triggering, and when one more call would break the budget, consolidate the remaining work into fewer, denser calls or stop and report.",
	},
];

const GEMINI_INTRO =
	"You are running on Gemini 3.x, a reasoning model. Reasoning is already on, so instructions are read as direct, literal input - the rules below calibrate style, grounding, and tool use rather than scaffolding thought.";

function buildGeminiTuning(): string {
	return [GEMINI_INTRO, ...GEMINI_RULES.map((rule) => rule.directive), "model-family: gemini"].join("\n\n");
}

export function buildGeminiPrompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({ ...options, tuningSection: buildGeminiTuning(), workstationDialect: "default" });
}
