import type { AvailableTool } from "./types.js";

function getToolCategory(name: string): AvailableTool["category"] {
	if (name.startsWith("lsp_")) {
		return "lsp";
	}
	if (name.startsWith("ast_grep")) {
		return "ast";
	}
	if (name === "grep" || name === "glob") {
		return "search";
	}
	if (name.startsWith("session_")) {
		return "session";
	}
	if (name === "skill") {
		return "command";
	}
	return "other";
}

export function categorizeTools(toolNames: string[]): AvailableTool[] {
	return toolNames.map((name) => ({ name, category: getToolCategory(name) }));
}

export function getToolsPromptDisplay(tools: AvailableTool[]): string {
	const displayNames: string[] = [];

	if (tools.some((tool) => tool.category === "search" && tool.name === "grep")) {
		displayNames.push("`grep`");
	}
	if (tools.some((tool) => tool.category === "search" && tool.name === "glob")) {
		displayNames.push("`glob`");
	}
	if (tools.some((tool) => tool.category === "lsp")) {
		displayNames.push("`lsp_*`");
	}
	if (tools.some((tool) => tool.category === "ast")) {
		displayNames.push("`ast_grep`");
	}

	return displayNames.join(", ");
}
