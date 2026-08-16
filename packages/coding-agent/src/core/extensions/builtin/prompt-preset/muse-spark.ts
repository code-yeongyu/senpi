// Muse Spark family tuning.
//
// Muse Spark is a coding-focused reasoning model whose vendor guidance (Meta's
// Muse Spark prompting notes, 2026-08) centers on capability honesty and
// evidence-anchored loops: use only the tools the client exposes, assume no
// hidden computer control, one goal per turn, claim success only with
// observed evidence, never invent file contents or UI state, summarize each
// observation before the next action, and checkpoint long tool chains. The
// preset stays a thin tuningSection wrapper over the shared dynamic core and
// carries those behaviors as typed rule data (gpt-5.6.ts / deepseek-v4.ts
// precedent) so tests assert parsed rules and routing tokens instead of
// pinned sentences.

import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";

export type MuseSparkRuleId =
	| "exposed-tools-only"
	| "no-hidden-control"
	| "one-goal-per-turn"
	| "evidence-before-success"
	| "observe-first"
	| "observation-summary"
	| "chain-checkpoints";

export type MuseSparkConcern = "tool-orchestration" | "grounding" | "verification" | "deliberation";

export interface MuseSparkRule {
	readonly id: MuseSparkRuleId;
	readonly concern: MuseSparkConcern;
	readonly directive: string;
}

export const MUSE_SPARK_RULES: readonly MuseSparkRule[] = [
	{
		id: "exposed-tools-only",
		concern: "tool-orchestration",
		directive:
			"Name only the tools the client exposes in this session and use only those: the tool list in this prompt is the complete capability set. Never call, reference, or promise a tool that is not listed.",
	},
	{
		id: "no-hidden-control",
		concern: "grounding",
		directive:
			"Do not assume hidden computer control, an unlisted IDE, background agents, or any capability beyond the exposed tools - if a capability is not in the tool list, it does not exist for this session.",
	},
	{
		id: "one-goal-per-turn",
		concern: "deliberation",
		directive:
			"Keep one goal per turn: state the single objective you are pursuing, work it to its stopping condition, and do not pile secondary objectives into the same turn.",
	},
	{
		id: "evidence-before-success",
		concern: "verification",
		directive:
			"Claim success only with concrete evidence in hand - file paths read, command output observed, state confirmed by a tool call this session. A plausible completion report without observed evidence is a fabrication.",
	},
	{
		id: "observe-first",
		concern: "grounding",
		directive:
			"Never invent file contents, command output, or UI state: before asserting anything about them, observe them with a real tool call. If you have not read it this session, you do not know it.",
	},
	{
		id: "observation-summary",
		concern: "tool-orchestration",
		directive:
			"After each tool call, summarize what the result actually showed in one line before taking the next action - observation first, then action - so every step stays anchored to evidence.",
	},
	{
		id: "chain-checkpoints",
		concern: "deliberation",
		directive:
			"Cap long tool chains with checkpoints: every few calls, stop and reconcile - what the goal was, what evidence you have, what remains - and if the chain has drifted from the goal, return to it or stop and report instead of wandering further.",
	},
];

const MUSE_SPARK_INTRO =
	"You are running on Muse Spark, a coding-focused reasoning model. The rules below bind tool use to the exposed capability set and keep every claim anchored to observed evidence.";

function buildMuseSparkTuning(): string {
	return [MUSE_SPARK_INTRO, ...MUSE_SPARK_RULES.map((rule) => rule.directive), "model-family: muse-spark"].join(
		"\n\n",
	);
}

export function buildMuseSparkPrompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: buildMuseSparkTuning(),
		workstationDialect: "default",
	});
}
