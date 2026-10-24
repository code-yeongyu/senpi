import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { McpServerDeclaredConfig, McpSettings } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { collectAllPages } from "./expose/pagination.ts";
import type { McpOutputArtifacts } from "./guard/output-guard.ts";
import type { McpEnsureFreshAuth } from "./health.ts";
import type { McpInvocationResolver } from "./invocation.ts";
import type { McpRequestOrigin } from "./request-origin.ts";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

export interface McpToolCatalogEntry {
	requestOrigin?: () => McpRequestOrigin | undefined;
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
	artifacts?: McpOutputArtifacts;
	outputGuard?: McpSettings["outputGuard"];
	invocation?: McpInvocationResolver;
}

type McpToolCatalogOptions = Pick<
	McpToolCatalogEntry,
	"agentDir" | "artifacts" | "ensureFresh" | "outputGuard" | "invocation" | "requestOrigin"
>;

export async function collectToolCatalog(
	server: string,
	connection: ServerConnection,
	config: McpServerDeclaredConfig,
	options: McpToolCatalogOptions = {},
): Promise<McpToolCatalogEntry[]> {
	const result = await collectAllPages<ListedTool>((cursor) =>
		connection.client.listTools(cursor === undefined ? {} : { cursor }, { timeout: config.requestTimeoutMs }),
	);
	return result.items.map((tool) => ({
		requestOrigin: options.requestOrigin,
		annotations: tool.annotations,
		agentDir: options.agentDir,
		artifacts: options.artifacts,
		connection,
		description: tool.description,
		ensureFresh: options.ensureFresh,
		invocation: options.invocation,
		outputGuard: options.outputGuard,
		requestTimeoutMs: config.requestTimeoutMs,
		schema: tool.inputSchema,
		server,
		tool: tool.name,
	}));
}

/** What registering these tools with this catalog's resources and prompts exposes;
 * equal identities register identical definitions. */
export function mcpRegistrationIdentity(
	tools: readonly McpToolCatalogEntry[],
	catalog: McpCachedServerCatalog | undefined,
): string {
	return JSON.stringify([
		tools.map((entry) => [entry.tool, entry.description, entry.schema, entry.annotations]),
		catalog?.resources ?? [],
		catalog?.prompts ?? [],
	]);
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
		requestOrigin: options.requestOrigin,
		annotations: tool.annotations,
		agentDir: options.agentDir,
		artifacts: options.artifacts,
		connection,
		description: tool.description,
		ensureConnected,
		ensureFresh: options.ensureFresh,
		invocation: options.invocation,
		outputGuard: options.outputGuard,
		requestTimeoutMs,
		schema: tool.inputSchema,
		server,
		tool: tool.name,
	}));
}
