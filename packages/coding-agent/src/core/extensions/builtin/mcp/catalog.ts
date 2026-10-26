import type { McpListedTool as ListedTool } from "./tool-contracts.ts";
import { listMcpTools } from "./tool-client.ts";
import { isModernMcpClient } from "./modern/request.ts";
import { hasSupportedModernToolSchemas } from "./modern/tool-schema.ts";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { McpServerDeclaredConfig, McpSettings } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { collectAllPages } from "./expose/pagination.ts";
import type { McpOutputArtifacts } from "./guard/output-guard.ts";
import type { McpEnsureFreshAuth } from "./health.ts";
import type { McpInvocationResolver } from "./invocation.ts";
import type { McpRequestOrigin } from "./request-origin.ts";

export interface McpToolCatalogEntry {
	requestOrigin?: () => McpRequestOrigin | undefined;
	server: string;
	tool: string;
	schema: ListedTool["inputSchema"];
	outputSchema?: ListedTool["outputSchema"];
	modern?: boolean;
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
		listMcpTools(connection.client, cursor === undefined ? {} : { cursor }, { timeout: config.requestTimeoutMs }),
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
		outputSchema: tool.outputSchema,
		modern: isModernMcpClient(connection.client),
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
		tools.map((entry) => [
			entry.tool,
			entry.description,
			entry.schema,
			entry.outputSchema,
			entry.modern,
			entry.annotations,
		]),
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
	const modern = connection.state === "connected" ? isModernMcpClient(connection.client) || undefined : catalog.modern;
	return catalog.tools
		.filter((tool) => !modern || hasSupportedModernToolSchemas(tool))
		.map((tool) => ({
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
			outputSchema: tool.outputSchema,
			modern,
			server,
			tool: tool.name,
		}));
}
