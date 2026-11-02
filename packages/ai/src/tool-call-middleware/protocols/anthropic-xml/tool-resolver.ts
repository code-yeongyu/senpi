import type { Tool } from "../../../types.ts";

export type ToolResolver = (toolName: string) => Tool | undefined;

const CC_MCP_PREFIX = /^mcp(?:__[^_]+)*__/;
const HASHED_MCP_PREFIX = /^mcp_[a-z0-9]+-/i;

/**
 * Reduces a tool name to its alias key: the wire-name decorations upstream
 * gateways add (CC-SDK `mcp__server__tool`, hashed `mcp_<hash>-Name`,
 * PascalCase disguises) collapse onto the same alphanumerics as the
 * registered snake_case name.
 */
function toAliasKey(name: string): string {
	const stripped = name.replace(CC_MCP_PREFIX, "").replace(HASHED_MCP_PREFIX, "");
	return stripped.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function createToolResolver(tools: readonly Tool[]): ToolResolver {
	const exactToolMap = new Map(tools.map((tool) => [tool.name, tool]));
	const insensitiveToolMap = new Map<string, Tool | null>();
	const aliasToolMap = new Map<string, Tool | null>();
	for (const tool of tools) {
		const normalizedName = tool.name.toLowerCase();
		const existing = insensitiveToolMap.get(normalizedName);
		insensitiveToolMap.set(normalizedName, existing === undefined ? tool : existing === tool ? tool : null);
		const aliasKey = toAliasKey(tool.name);
		const existingAlias = aliasToolMap.get(aliasKey);
		aliasToolMap.set(aliasKey, existingAlias === undefined ? tool : existingAlias === tool ? tool : null);
	}

	return (toolName: string): Tool | undefined => {
		const exactTool = exactToolMap.get(toolName);
		if (exactTool) {
			return exactTool;
		}

		const insensitiveTool = insensitiveToolMap.get(toolName.toLowerCase());
		if (insensitiveTool) {
			return insensitiveTool;
		}

		return aliasToolMap.get(toAliasKey(toolName)) ?? undefined;
	};
}
