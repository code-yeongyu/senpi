import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

function buildClaudeOpus45Tuning(): string {
	return `Break complex tasks into ordered steps with clear dependencies before executing. When a request covers a set of items, apply it to every item rather than only the first, and state the scope you applied.

Write in the user's language (the one their instructions name, else the one they write in): every reply, note between tool calls, and todo label, and keep it after reading tool output, files, or skills written in another language.`;
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
