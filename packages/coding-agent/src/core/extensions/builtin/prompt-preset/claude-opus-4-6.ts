import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

export function buildClaudeOpus46Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: buildExecutionToolingSection({ toolNames: options.selectedTools, dialect: "claude" }),
		workstationDialect: "claude",
	});
}
