import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

function buildClaudeOpus45Tuning(): string {
	return `Break complex tasks into ordered steps with clear dependencies before executing. When a request covers a set of items, apply it to every item rather than only the first, and state the scope you applied.`;
}

export function buildClaudeOpus45Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: [
			buildExecutionToolingSection({ toolNames: options.selectedTools, dialect: "claude" }),
			buildClaudeOpus45Tuning(),
		]
			.filter((section) => section.length > 0)
			.join("\n\n"),
		workstationDialect: "claude",
	});
}
