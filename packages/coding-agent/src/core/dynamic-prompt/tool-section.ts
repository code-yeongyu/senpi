import { getEvalOnlyGrepGuideline } from "../system-prompt.ts";
import type { AvailableTool, SharedSections } from "./types.ts";

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
 * listed tool and no guideline the section renders empty. `sharedSections: "full"` keeps the pre-diet
 * shape: the heading always renders, with `(none)` when no tool is listed (senpi#5665).
 */
export function buildToolSection(options: {
	tools: AvailableTool[];
	toolSnippets: Record<string, string>;
	promptGuidelines?: string[];
	sharedSections?: SharedSections;
}): string {
	const full = options.sharedSections === "full";
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

	const lines: string[] = full ? ["## Available Tools", ""] : [];
	let hasVisibleTools = false;

	for (const category of CATEGORY_ORDER) {
		const categoryTools = groupedTools.get(category);
		if (!categoryTools || categoryTools.length === 0) {
			continue;
		}

		if (lines.length === 0) lines.push("## Available Tools", "");
		hasVisibleTools = true;
		lines.push(`### ${CATEGORY_LABELS[category]}`);
		for (const tool of categoryTools) {
			lines.push(`- ${tool.name}: ${tool.snippet}`);
		}
		lines.push("");
	}

	if (full && !hasVisibleTools) {
		lines.push("(none)", "");
	}

	const guidelines =
		options.promptGuidelines?.map((guideline) => guideline.trim()).filter((guideline) => guideline) ?? [];
	const evalOnlyGrepGuideline = getEvalOnlyGrepGuideline(
		options.tools.map(({ name }) => name),
		options.toolSnippets,
		options.sharedSections,
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
