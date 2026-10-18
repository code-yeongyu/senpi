import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export type GlobToolOptions = FindToolOptions;

export function createGlobToolDefinition(
	cwd: string,
	options?: GlobToolOptions,
): ReturnType<typeof createFindToolDefinition> {
	const find = createFindToolDefinition(cwd, options);
	return {
		...find,
		name: "glob",
		label: "glob",
		exposure: "eval",
		description:
			"Find files by glob with tool.glob({ pattern, path }) inside eval. Returns matching paths relative to the search directory, respects .gitignore, and applies hooks and permissions.",
		promptSnippet: undefined,
	};
}

export function createGlobTool(cwd: string, options?: GlobToolOptions): AgentTool {
	return wrapToolDefinition(createGlobToolDefinition(cwd, options));
}
