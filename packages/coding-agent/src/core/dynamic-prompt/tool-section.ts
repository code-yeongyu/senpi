import { getEvalOnlyGrepGuideline } from "../system-prompt.ts";
import type { AvailableTool } from "./types.ts";

const CATEGORY_ORDER = ["search", "other", "session", "command"] as const;

const CATEGORY_LABELS: Record<AvailableTool["category"], string> = {
	search: "Search",
	other: "Core Tools",
	session: "Session",
	command: "Commands",
};

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

	const lines = ["## Available Tools", ""];
	let hasVisibleTools = false;

	for (const category of CATEGORY_ORDER) {
		const categoryTools = groupedTools.get(category);
		if (!categoryTools || categoryTools.length === 0) {
			continue;
		}

		hasVisibleTools = true;
		lines.push(`### ${CATEGORY_LABELS[category]}`);
		for (const tool of categoryTools) {
			lines.push(`- ${tool.name}: ${tool.snippet}`);
		}
		lines.push("");
	}

	if (!hasVisibleTools) {
		lines.push("(none)", "");
	}

	const guidelines = buildToolGuidelinesSection(options);
	if (guidelines) lines.push(guidelines, "");

	return lines.join("\n").trimEnd();
}

/** The "## Tool Guidelines" block alone, or "" when no tool contributes a guideline. */
export function buildToolGuidelinesSection(options: {
	tools: AvailableTool[];
	toolSnippets: Record<string, string>;
	promptGuidelines?: string[];
}): string {
	const guidelines =
		options.promptGuidelines?.map((guideline) => guideline.trim()).filter((guideline) => guideline) ?? [];
	const evalOnlyGrepGuideline = getEvalOnlyGrepGuideline(
		options.tools.map(({ name }) => name),
		options.toolSnippets,
	);
	if (evalOnlyGrepGuideline) guidelines.unshift(evalOnlyGrepGuideline);
	if (guidelines.length === 0) return "";
	return ["## Tool Guidelines", "", ...guidelines.map((guideline) => `- ${guideline}`)].join("\n");
}
