// MCP resources (todo 39): list/read/subscribe + @mcp: input-mention expansion.
//
// Model-facing access is two utility tools — mcp_list_resources and
// mcp_read_resource — registered ONLY when at least one connected server
// actually lists resources (no dead tools). User-facing convenience is the
// `@mcp:<server>/<uri>` mention, expanded through the sanctioned `input` event
// transform: recognized mentions are replaced inline with the fetched resource
// body (output-guarded); unrecognized or failing mentions pass through
// UNCHANGED with a one-line notice, never blocking the submission. Servers
// declaring the resources.subscribe capability get per-resource subscriptions;
// updated/list_changed notifications flow into the existing tools-changed
// refresh path, so the catalog cache stays current.

import { Text } from "@earendil-works/pi-tui";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../types.ts";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { ServerConnection } from "./connection.ts";
import { ToolExecError } from "./errors.ts";
import type { McpToolDetails } from "./expose/register.ts";
import type { McpOutputArtifacts } from "./guard/output-guard.ts";
import { applyMcpOutputGuard } from "./guard/output-guard.ts";

export interface McpResourceServer {
	readonly server: string;
	readonly connection: ServerConnection;
	readonly agentDir?: string;
	readonly artifacts?: McpOutputArtifacts;
	readonly outputGuard?: Parameters<typeof applyMcpOutputGuard>[1]["outputGuard"];
	readonly requestTimeoutMs?: number;
	readonly resources: NonNullable<McpCachedServerCatalog["resources"]>;
}

/** Route resource updated notifications into the shared refresh path. */
export function subscribeMcpResourceUpdated(client: Client, onChange: () => void): void {
	client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
		onChange();
	});
}

/** Best-effort per-resource subscriptions when the server declares support. */
export async function ensureMcpResourceSubscriptions(
	client: Client,
	resources: ReadonlyArray<{ uri: string }>,
): Promise<void> {
	if (client.getServerCapabilities()?.resources?.subscribe !== true) return;
	await Promise.all(
		resources.map((resource) => client.subscribeResource({ uri: resource.uri }).catch(() => undefined)),
	);
}

/** Read one resource and flatten its contents to guarded text. */
export async function readMcpResourceAsText(server: McpResourceServer, uri: string): Promise<string> {
	let contents: Awaited<ReturnType<Client["readResource"]>>["contents"];
	try {
		const result = await server.connection.client.readResource({ uri }, { timeout: server.requestTimeoutMs });
		contents = result.contents;
	} catch (error) {
		throw new ToolExecError(
			`Failed to read MCP resource ${uri}: ${error instanceof Error ? error.message : String(error)}`,
			{
				phase: "call",
				serverName: server.server,
			},
		);
	}
	const parts = contents.map((content) => {
		if ("text" in content && typeof content.text === "string") return content.text;
		const blob = "blob" in content && typeof content.blob === "string" ? content.blob : "";
		return `[binary resource ${content.uri} (${content.mimeType ?? "unknown"}), ~${Math.round((blob.length * 3) / 4)} bytes]`;
	});
	const guarded = await applyMcpOutputGuard([{ type: "text", text: parts.join("\n") }], {
		agentDir: server.agentDir,
		artifacts: server.artifacts,
		outputGuard: server.outputGuard,
		server: server.server,
	});
	return guarded.map((block) => ("text" in block && typeof block.text === "string" ? block.text : "")).join("\n");
}

const ListParams = Type.Object({
	server: Type.Optional(Type.String({ description: "Restrict to one MCP server name." })),
});
const ReadParams = Type.Object({
	server: Type.String({ description: "MCP server name (from mcp_list_resources)." }),
	uri: Type.String({ description: "Resource URI to read." }),
});

type McpUtilityTool = ToolDefinition<typeof ListParams | typeof ReadParams, McpToolDetails | undefined, unknown>;

/** The two model-facing utility tools. Register only when servers() is non-empty. */
export function createMcpResourceTools(servers: () => readonly McpResourceServer[]): McpUtilityTool[] {
	const list: ToolDefinition<typeof ListParams, McpToolDetails | undefined, unknown> = {
		name: "mcp_list_resources",
		label: "List MCP resources",
		description: "List resources exposed by connected MCP servers (URI, name, mime type).",
		parameters: ListParams,
		executionMode: "parallel",
		async execute(_id, params: Static<typeof ListParams>) {
			const scoped = servers().filter((entry) => params.server === undefined || entry.server === params.server);
			const lines = scoped.flatMap((entry) =>
				entry.resources.map(
					(resource) =>
						`- @mcp:${entry.server}/${resource.uri} — ${resource.name ?? resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}`,
				),
			);
			const text = lines.length === 0 ? "No MCP resources available." : lines.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					preview: `${lines.length} resource(s)`,
					server: params.server ?? "*",
					tool: "mcp_list_resources",
				},
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`mcp_list_resources ${args.server ?? ""}`.trim())), 0, 0);
		},
	};
	const read: ToolDefinition<typeof ReadParams, McpToolDetails | undefined, unknown> = {
		name: "mcp_read_resource",
		label: "Read MCP resource",
		description: "Read one MCP resource by server name and URI; returns its (guarded) content.",
		parameters: ReadParams,
		executionMode: "parallel",
		async execute(_id, params: Static<typeof ReadParams>) {
			const entry = servers().find((candidate) => candidate.server === params.server);
			if (entry === undefined) {
				throw new ToolExecError(`Unknown MCP server '${params.server}' for resource ${params.uri}.`, {
					phase: "call",
					serverName: params.server,
				});
			}
			const text = await readMcpResourceAsText(entry, params.uri);
			return {
				content: [{ type: "text", text }],
				details: { preview: params.uri, server: params.server, tool: "mcp_read_resource" },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`mcp_read_resource ${args.server}/${args.uri}`)), 0, 0);
		},
	};
	return [list as McpUtilityTool, read as McpUtilityTool];
}

const MENTION_PATTERN = /@mcp:([A-Za-z0-9._-]+)\/(\S+)/g;

export interface McpMentionExpansion {
	readonly text: string;
	readonly changed: boolean;
	readonly notices: string[];
}

/** Expand `@mcp:<server>/<uri>` mentions; failures leave the mention intact. */
export async function expandMcpResourceMentions(
	text: string,
	servers: () => readonly McpResourceServer[],
): Promise<McpMentionExpansion> {
	const matches = [...text.matchAll(MENTION_PATTERN)];
	if (matches.length === 0) return { changed: false, notices: [], text };
	const notices: string[] = [];
	let expanded = text;
	for (const match of matches) {
		const [mention, serverName, uri] = match;
		const entry = servers().find((candidate) => candidate.server === serverName);
		if (entry === undefined) {
			notices.push(`@mcp mention left as-is: unknown server '${serverName}'.`);
			continue;
		}
		try {
			const body = await readMcpResourceAsText(entry, uri);
			expanded = expanded.replace(
				mention,
				`<mcp-resource server="${serverName}" uri="${uri}">\n${body}\n</mcp-resource>`,
			);
		} catch (error) {
			notices.push(`@mcp mention left as-is: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { changed: expanded !== text, notices, text: expanded };
}
