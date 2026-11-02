import { getEvalOnlyGrepGuideline } from "../system-prompt.ts";
import type { AvailableTool } from "./types.ts";

const CATEGORY_ORDER = ["search", "other", "session", "command"] as const;

const CATEGORY_LABELS: Record<AvailableTool["category"], string> = {
	search: "Search",
	other: "Core Tools",
	session: "Session",
	command: "Commands",
};

/**
 * Lists only tools that carry a snippet; callers pass snippets solely for tools whose schema the model
 * does not see described, so a tool's own description is never restated here (senpi#5335). With no
 * listed tool and no guideline the section renders empty.
 */
export function buildToolSection(options: {
	tools: AvailableTool[];
	toolSnippets: Record<string, string>;
	promptGuidelines?: string[];
}): string {
	const groupedTools = new Map<AvailableTool["category"], Array<{ name: string; snippet: string }>>();

	for (const tool of options.tools) {
		const snippet = options.toolSnippets[tool.name]?.trim();
		if (!snippet) {
			continue;
		}

		const existingTools = groupedTools.get(tool.category) ?? [];
		existingTools.push({ name: tool.name, snippet });
		groupedTools.set(tool.category, existingTools);
	}

	const lines: string[] = [];

	for (const category of CATEGORY_ORDER) {
		const categoryTools = groupedTools.get(category);
		if (!categoryTools || categoryTools.length === 0) {
			continue;
		}

		if (lines.length === 0) lines.push("## Available Tools", "");
		lines.push(`### ${CATEGORY_LABELS[category]}`);
		for (const tool of categoryTools) {
			lines.push(`- ${tool.name}: ${tool.snippet}`);
		}
		lines.push("");
	}

	const guidelines =
		options.promptGuidelines?.map((guideline) => guideline.trim()).filter((guideline) => guideline) ?? [];
	const evalOnlyGrepGuideline = getEvalOnlyGrepGuideline(
		options.tools.map(({ name }) => name),
		options.toolSnippets,
	);
	if (evalOnlyGrepGuideline) guidelines.unshift(evalOnlyGrepGuideline);
	if (guidelines.length > 0) {
		lines.push("## Tool Guidelines", "");
		for (const guideline of guidelines) {
			lines.push(`- ${guideline}`);
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}
