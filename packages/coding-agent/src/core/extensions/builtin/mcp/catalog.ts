import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { McpServerConfig, McpSettings } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { collectAllPages } from "./expose/pagination.ts";
import type { McpEnsureFreshAuth } from "./health.ts";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

export interface McpToolCatalogEntry {
	server: string;
	tool: string;
	schema: ListedTool["inputSchema"];
	description?: string;
	annotations?: ListedTool["annotations"];
	requestTimeoutMs: number;
	connection: ServerConnection;
	ensureConnected?: () => Promise<void>;
	ensureFresh?: McpEnsureFreshAuth;
	agentDir?: string;
	outputGuard?: McpSettings["outputGuard"];
}

type McpToolCatalogOptions = Pick<McpToolCatalogEntry, "agentDir" | "ensureFresh" | "outputGuard">;

export async function collectToolCatalog(
	server: string,
	connection: ServerConnection,
	config: McpServerConfig,
	options: McpToolCatalogOptions = {},
): Promise<McpToolCatalogEntry[]> {
	const result = await collectAllPages<ListedTool>((cursor) =>
		connection.client.listTools(cursor === undefined ? {} : { cursor }, { timeout: config.requestTimeoutMs }),
	);
	return result.items.map((tool) => ({
		annotations: tool.annotations,
		agentDir: options.agentDir,
		connection,
		description: tool.description,
		ensureFresh: options.ensureFresh,
		outputGuard: options.outputGuard,
		requestTimeoutMs: config.requestTimeoutMs,
		schema: tool.inputSchema,
		server,
		tool: tool.name,
	}));
}

export function cachedToolsToCatalogEntries(
	server: string,
	catalog: McpCachedServerCatalog,
	connection: ServerConnection,
	requestTimeoutMs: number,
	ensureConnected: () => Promise<void>,
	options: McpToolCatalogOptions = {},
): McpToolCatalogEntry[] {
	return catalog.tools.map((tool) => ({
		annotations: tool.annotations,
		agentDir: options.agentDir,
		connection,
		description: tool.description,
		ensureConnected,
		ensureFresh: options.ensureFresh,
		outputGuard: options.outputGuard,
		requestTimeoutMs,
		schema: tool.inputSchema,
		server,
		tool: tool.name,
	}));
}
