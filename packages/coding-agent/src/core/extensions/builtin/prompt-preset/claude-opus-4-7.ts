import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.js";

function buildClaudeOpus47Tuning(): string {
	return `When an instruction names a scope like "every", "all", or "for each", apply it to the full set rather than the first item. When told "do X then Y", follow that exact sequence.

Maintain coherent state across extended multi-tool workflows without drifting from the original goal. Do not re-anchor with reminder paragraphs mid-task.`;
}

export function buildClaudeOpus47Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({ ...options, tuningSection: buildClaudeOpus47Tuning() });
}
