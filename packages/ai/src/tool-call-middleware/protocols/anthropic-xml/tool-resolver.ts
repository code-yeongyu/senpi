import type { Tool } from "../../../types.ts";

export type ToolResolver = (toolName: string) => Tool | undefined;

export function createToolResolver(tools: readonly Tool[]): ToolResolver {
	const exactToolMap = new Map(tools.map((tool) => [tool.name, tool]));
	const insensitiveToolMap = new Map<string, Tool | null>();
	for (const tool of tools) {
		const normalizedName = tool.name.toLowerCase();
		const existing = insensitiveToolMap.get(normalizedName);
		insensitiveToolMap.set(normalizedName, existing === undefined ? tool : existing === tool ? tool : null);
	}

	return (toolName: string): Tool | undefined => {
		const exactTool = exactToolMap.get(toolName);
		if (exactTool) {
			return exactTool;
		}

		return insensitiveToolMap.get(toolName.toLowerCase()) ?? undefined;
	};
}
