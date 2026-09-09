import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

export const GLM5_TUNING =
	"A cheap tool call beats long internal debate: when reading, running, or searching can settle a question, do that and reason over the result. Work in short act-inspect-verify loops so an early mistake surfaces before later steps build on it.";

export function buildGlm5Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: [
			buildExecutionToolingSection({ toolNames: options.selectedTools, dialect: "claude" }),
			GLM5_TUNING,
		]
			.filter((section) => section.length > 0)
			.join("\n\n"),
		workstationDialect: "claude",
	});
}
