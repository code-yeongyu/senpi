import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.js";

function buildClaudeOpus46Tuning(): string {
	return `When a task applies to multiple items, state the full scope explicitly rather than relying on implication. Default output is thorough — constrain with "one sentence", "bullets only", "no preamble" when concise output is needed.`;
}

export function buildClaudeOpus46Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({ ...options, tuningSection: buildClaudeOpus46Tuning() });
}
