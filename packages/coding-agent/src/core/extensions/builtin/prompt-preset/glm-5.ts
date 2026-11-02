import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

export const GLM5_TUNING =
	"Cheap tool call beats long internal debate: reading/running/searching can settle it -> do that, reason over result. Short act-inspect-verify loops so early mistakes surface before later steps build on them. Only the user can settle it -> ask_user_question when available.";

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
