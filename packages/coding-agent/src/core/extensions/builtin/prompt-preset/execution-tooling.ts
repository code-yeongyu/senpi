// Execution-tooling stance shared by the Claude and Kimi presets. The eval tool
// description already teaches cell mechanics per dialect and the terminal prompt
// already documents monitor; this module carries the ROUTING decision those
// descriptions cannot make for the model - eval is the default surface for any
// multi-call step - and renders only when eval is actually selected. Dialects
// follow the prompt-engineering references: Claude takes a tagged block with
// uppercase key verbs; Kimi takes positive DO-framing with terminal conditions
// and no all-caps NEVER (the K2.6 guidance says prohibitions make it overthink).
//
// The wait-as-subscription stance lives in the eval tool description instead:
// `monitor` is reachable only through an eval cell, so a rule gated on it being
// directly selected could never render, and only the description can teach the
// `tool.monitor(...)` form the model must actually type.

export type ExecutionToolingRuleId = "eval-default-surface" | "eval-real-code" | "eval-stay-direct";

export type ExecutionToolingConcern = "code-cell-routing";

export type ExecutionToolingDialect = "claude" | "kimi";

export interface ExecutionToolingRule {
	readonly id: ExecutionToolingRuleId;
	readonly concern: ExecutionToolingConcern;
	readonly directive: Readonly<Record<ExecutionToolingDialect, string>>;
}

export const EXECUTION_TOOLING_RULES = [
	{
		id: "eval-default-surface",
		concern: "code-cell-routing",
		directive: {
			claude:
				"`eval` is your DEFAULT execution surface, not a fallback: the moment a step needs more than one tool call - reads, searches, symbol lookups, shell commands, web fetches, subagent spawns - write ONE cell that performs the WHOLE step. Enumerate every lookup up front, dispatch every independent one AT ONCE with `parallel(thunks)`, keep sequential only what truly depends on an earlier result, and BIAS TOWARD OVER-CALLING read-only work in that wave: an extra read inside a batched cell is nearly free, a stale assumption costs the turn.",
			kimi: "**MAKE `eval` YOUR DEFAULT WAY TO ACT.** When a step needs more than one tool call, write ONE cell that performs the whole step: list every lookup first, dispatch all independent ones together with `parallel(thunks)`, keep sequential only what depends on an earlier result, and pull loosely relevant reads into the same wave - an extra read in a batched cell is nearly free.",
		},
	},
	{
		id: "eval-real-code",
		concern: "code-cell-routing",
		directive: {
			claude:
				"Write REAL programs in those cells, not call lists: `if`/`for` over targets, `map`/`filter`/`reduce`, joins, dedup, aggregation, a `try`/`catch` per risky item so one failure degrades only that item, and return DISTILLED, decision-ready facts - never raw dumps.",
			kimi: "**WRITE REAL CODE IN THE CELL:** `if`/`for` over targets, `map`/`filter`/`reduce`, joins and aggregation, a `try`/`catch` per risky item so the rest of the batch completes, and return distilled facts.",
		},
	},
	{
		id: "eval-stay-direct",
		concern: "code-cell-routing",
		directive: {
			claude:
				"Call a tool directly only when one call is enough, the result decides the next call, semantic judgment sits between calls, or the action needs approval.",
			kimi: "Use a direct tool call when one call is enough, when each result decides the next call, or when the action needs approval - then stop deliberating and make it.",
		},
	},
] as const satisfies readonly ExecutionToolingRule[];

const CONCERN_TOOL: Readonly<Record<ExecutionToolingConcern, string>> = {
	"code-cell-routing": "eval",
};

export interface BuildExecutionToolingSectionOptions {
	readonly toolNames: readonly string[];
	readonly dialect: ExecutionToolingDialect;
}

/** Directives for the selected tools, or "" when eval is not available. */
export function buildExecutionToolingSection(options: BuildExecutionToolingSectionOptions): string {
	const paragraphs = EXECUTION_TOOLING_RULES.filter((rule) =>
		options.toolNames.includes(CONCERN_TOOL[rule.concern]),
	).map((rule) => rule.directive[options.dialect]);
	if (paragraphs.length === 0) {
		return "";
	}
	const body = paragraphs.join("\n\n");
	return options.dialect === "claude" ? `<execution_tooling>\n${body}\n</execution_tooling>` : body;
}

/** Same as buildExecutionToolingSection but followed by a paragraph gap, for inline placement. */
export function buildExecutionToolingParagraph(options: BuildExecutionToolingSectionOptions): string {
	const section = buildExecutionToolingSection(options);
	return section ? `${section}\n\n` : "";
}
