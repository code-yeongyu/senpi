import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

export type Glm5RuleId = "load-matching-skills";
export type Glm5Concern = "skill-utilization";

export interface Glm5Rule {
	readonly id: Glm5RuleId;
	readonly concern: Glm5Concern;
	readonly directive: string;
}

export const GLM5_RULES: readonly Glm5Rule[] = [
	{
		id: "load-matching-skills",
		concern: "skill-utilization",
		directive:
			"Before the first non-discovery action, compare the task with every visible skill description. For each loose match, read that skill's listed `SKILL.md` and follow it; when matching work is delegated, include the skill name in `load_skills`. Proceed without a skill only after this scan finds no match - recognizing a match without loading it does not complete the gate.",
	},
];

export const GLM5_TUNING =
	"A cheap tool call beats long internal debate: when reading, running, or searching can settle a question, do that and reason over the result. Work in short act-inspect-verify loops so an early mistake surfaces before later steps build on it.";

export function buildGlm5Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: [
			buildExecutionToolingSection({ toolNames: options.selectedTools, dialect: "claude" }),
			GLM5_RULES[0].directive,
			GLM5_TUNING,
		]
			.filter((section) => section.length > 0)
			.join("\n\n"),
		workstationDialect: "claude",
	});
}
