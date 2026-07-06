import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServerConfig } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { collectAllPages } from "./expose/pagination.ts";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

export interface McpToolCatalogEntry {
	server: string;
	tool: string;
	schema: ListedTool["inputSchema"];
	description?: string;
	annotations?: ListedTool["annotations"];
	requestTimeoutMs: number;
	connection: ServerConnection;
}

export async function collectToolCatalog(
	server: string,
	connection: ServerConnection,
	config: McpServerConfig,
): Promise<McpToolCatalogEntry[]> {
	const result = await collectAllPages<ListedTool>((cursor) =>
		connection.client.listTools(cursor === undefined ? {} : { cursor }, { timeout: config.requestTimeoutMs }),
	);
	return result.items.map((tool) => ({
		annotations: tool.annotations,
		connection,
		description: tool.description,
		requestTimeoutMs: config.requestTimeoutMs,
		schema: tool.inputSchema,
		server,
		tool: tool.name,
	}));
}
