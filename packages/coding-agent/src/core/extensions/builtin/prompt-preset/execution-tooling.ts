// Execution-tooling stance shared by the Claude and Kimi presets. The eval tool
// description teaches cell mechanics per dialect and the terminal prompt
// documents monitor; this module carries the ROUTING decision those
// descriptions cannot make for the model, and renders only when eval is
// actually selected. Dialects follow the prompt-engineering references: Claude
// takes a tagged block with a few uppercase key verbs; Kimi takes positive
// DO-framing with terminal conditions and no all-caps prohibitions (the K
// guidance says shouting makes it overthink).
//
// 2026-09-09: the rule set moved from "one cell per multi-call step" to a
// dependency decision plus state-oriented verification. A census of 5,187
// sessions found the "assumed instead of observed" failures clustered where a
// batch hid its own evidence: edits and side-effecting commands fired in one
// cell with a short aggregate return, failures folded into missing rows by a
// per-item try/catch, truncated output acted on, and visual work changed
// without being looked at (a frontend edit was followed by a screenshot 24% of
// the time). Batching therefore applies to independent reads and probes;
// edits, side effects, approvals, and result-dependent calls run one at a time
// and are observed; every cell is compared with the state it was meant to
// produce; and perceived results (pages, images, 3D scenes) get a
// change-render-look loop.
//
// The wait-as-subscription stance lives in the eval tool description instead:
// `monitor` is reachable only through an eval cell, so a rule gated on it being
// directly selected could never render, and only the description can teach the
// `tool.monitor(...)` form the model must actually type.

export type ExecutionToolingRuleId =
	| "eval-routing-decision"
	| "eval-evidence-return"
	| "perceived-state-loop"
	| "eval-stay-direct";

export type ExecutionToolingConcern = "code-cell-routing";

export type ExecutionToolingDialect = "claude" | "kimi";

export interface ExecutionToolingRule {
	readonly id: ExecutionToolingRuleId;
	readonly concern: ExecutionToolingConcern;
	readonly directive: Readonly<Record<ExecutionToolingDialect, string>>;
}

export const EXECUTION_TOOLING_RULES = [
	{
		id: "eval-routing-decision",
		concern: "code-cell-routing",
		directive: {
			claude:
				"Sort a multi-call step before you write it: independent reads, searches, symbol lookups, and probes go into ONE `eval` cell together via `parallel(thunks)` - an extra read-only call in that wave is nearly free, a stale assumption costs the turn - while edits, side-effecting commands, deploys, approvals, and any call whose input is a result you have not seen yet run one at a time, each observed before the next.",
			kimi: "Sort a multi-call step before you write it: put independent reads, searches, symbol lookups, and probes into one `eval` cell together with `parallel(thunks)`, and run edits, side-effecting commands, deploys, approvals, and any call that depends on a result you have not seen yet one at a time, looking at each result before the next.",
		},
	},
	{
		id: "eval-evidence-return",
		concern: "code-cell-routing",
		directive: {
			claude:
				"Name the state a cell should produce before running it; when it returns, COMPARE the returned evidence with that state, and for a cell that changed something also check that nothing changed beyond it. A result that hides a failed item or a truncated tail is not evidence.",
			kimi: "Name the state a cell should produce before running it; when it returns, compare the returned evidence with that state, and for a cell that changed something also check that nothing changed beyond it. A result that hides a failed item or a truncated tail is not evidence.",
		},
	},
	{
		id: "perceived-state-loop",
		concern: "code-cell-routing",
		directive: {
			claude:
				"When the result must be SEEN rather than read - a page, a component, an image, a 3D scene, a layout - make one change, render or screenshot it, look, then make the next; check a 3D scene from several angles and a page at desktop and mobile widths. Compare what you see with the reference or the stated intent, and ask only where two readings of that intent diverge.",
			kimi: "When the result must be seen rather than read - a page, a component, an image, a 3D scene, a layout - make one change, render or screenshot it, look, then make the next; check a 3D scene from several angles and a page at desktop and mobile widths. Compare what you see with the reference or the stated intent, and ask only where two readings of that intent diverge.",
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
