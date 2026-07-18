import type { McpToolCatalogEntry } from "../catalog.ts";
import type { McpServerConfig, McpSettings } from "../config-schema.ts";
import type { ServerConnection } from "../connection.ts";
import { computeMcpExposurePolicy } from "./policy.ts";

export interface McpServerExposureStatus {
	readonly hint?: string;
	readonly toolCount: number | null;
	readonly mode?: "direct" | "search" | "proxy";
}

export function getMcpCatalogExposureStatus(
	catalog: readonly McpToolCatalogEntry[],
	serverConfig: McpServerConfig,
	settings: McpSettings,
): McpServerExposureStatus {
	const policy = computeMcpExposurePolicy(catalog, serverConfig, settings);
	if (policy.filteredEntries.length === 0) {
		return { hint: "No MCP tools matched includeTools/excludeTools filters.", toolCount: 0, mode: policy.mode };
	}
	// Report the total exposed tools; in search mode note how many are active now.
	const hint =
		policy.mode === "search"
			? `search mode: ${policy.activeEntries.length} active now, ${policy.registeredEntries.length} searchable via tool_search`
			: undefined;
	return { hint, toolCount: policy.registeredEntries.length, mode: policy.mode };
}

export async function getMcpServerExposureStatus(
	name: string,
	connection: ServerConnection,
	serverConfig: McpServerConfig,
	settings: McpSettings,
): Promise<McpServerExposureStatus> {
	try {
		const result = await connection.client.listTools({}, { timeout: 500 });
		const catalog: McpToolCatalogEntry[] = result.tools.map((tool) => ({
			annotations: tool.annotations,
			connection,
			description: tool.description,
			requestTimeoutMs: serverConfig.requestTimeoutMs,
			schema: tool.inputSchema,
			server: name,
			tool: tool.name,
		}));
		return getMcpCatalogExposureStatus(catalog, serverConfig, settings);
	} catch {
		return { toolCount: null };
	}
}
