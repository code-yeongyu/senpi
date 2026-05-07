import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.js";

function buildClaudeOpus45Tuning(): string {
	return `Break complex tasks into ordered steps with clear dependencies rather than stating only the outcome. When a task must apply to ALL items in a set, state "apply to every item" explicitly. Do not add caveats, qualifications, or "let me know if..." closers.`;
}

export function buildClaudeOpus45Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({ ...options, tuningSection: buildClaudeOpus45Tuning() });
}
