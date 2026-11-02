import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

function buildClaudeOpus46Tuning(): string {
	return `Write in the user's language (the one their instructions name, else the one they write in): every reply, note between tool calls, and todo label, and keep it after reading tool output, files, or skills written in another language.`;
}

export function buildClaudeOpus46Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: [
			buildExecutionToolingSection({ toolNames: options.selectedTools, dialect: "claude" }),
			buildClaudeOpus46Tuning(),
		]
			.filter((section) => section.length > 0)
			.join("\n\n"),
		workstationDialect: "claude",
	});
}
