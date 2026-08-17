import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";

export type Glm52RuleId = "load-matching-skills";
export type Glm52Concern = "skill-utilization";
export interface Glm52Rule { readonly id: Glm52RuleId; readonly concern: Glm52Concern; readonly directive: string; }
export const GLM_52_RULES: readonly Glm52Rule[] = [{ id: "load-matching-skills", concern: "skill-utilization", directive: "Before the first non-discovery action, compare the task with every visible skill description. For each loose match, read that skill's listed `SKILL.md` and follow it; when matching work is delegated, include the skill name in `load_skills`. Proceed without a skill only after this scan finds no match - recognizing a match without loading it does not complete the gate." }];

function buildGlm52Tuning(): string {
	return `You are running on GLM 5.2: Opus 4.6-class agent behavior tuned toward Fable 5 decisiveness and GPT 5.5 outcome-first coding. Apply literal scopes literally - "every", "all", and "for each" mean the full set. Prefer sufficient context over exhaustive context, pick minor decisions and note them, and use matching tools or skills immediately instead of under-reaching.

${GLM_52_RULES[0].directive}

Calibrate deliberation. Use extended reasoning only for genuine multi-step uncertainty; routine classification, file edits, and lookups should be decided directly. A cheap tool call beats long internal debate: act, inspect evidence, and verify.

Code toward the destination: define the outcome, constraints, and stopping condition, then work without mechanical step-by-step recitation. In ultrawork mode, maintain absolute certainty discipline: preserve the goal, prove completion with evidence, and do not deliver partial work.

The intent gate routing line is non-optional every turn. For non-trivial tasks, call todo with atomic items before starting, keep exactly one item in progress, and complete each item immediately when done.`;
}

export function buildGlm52Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({ ...options, tuningSection: buildGlm52Tuning(), workstationDialect: "claude" });
}
