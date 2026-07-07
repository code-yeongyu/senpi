import type { McpToolCatalogEntry } from "../catalog.ts";
import type { McpServerConfig, McpSettings } from "../config-schema.ts";
import type { ServerConnection } from "../connection.ts";
import { computeMcpExposurePolicy } from "./policy.ts";

export interface McpServerExposureStatus {
	readonly hint?: string;
	readonly toolCount: number | null;
}

export function getMcpCatalogExposureStatus(
	catalog: readonly McpToolCatalogEntry[],
	serverConfig: McpServerConfig,
	settings: McpSettings,
): McpServerExposureStatus {
	const policy = computeMcpExposurePolicy(catalog, serverConfig, settings);
	return {
		hint: policy.filteredEntries.length === 0 ? "No MCP tools matched includeTools/excludeTools filters." : undefined,
		toolCount: policy.activeEntries.length,
	};
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
