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
import { type Static, Type } from "typebox";
import { redactResolvedReferenceData, redactResolvedReferenceValues } from "../../../config-reference-redaction.ts";
import type { ToolDefinition } from "../../types.ts";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { ServerConnection } from "./connection.ts";
import { ToolExecError } from "./errors.ts";
import type { McpToolDetails } from "./expose/register.ts";
import type { McpOutputArtifacts } from "./guard/output-guard.ts";
import { applyMcpOutputGuard } from "./guard/output-guard.ts";
import { ResourceUpdatedNotificationSchema, registerMcpNotificationHandler } from "./notification-schemas.ts";
import { type McpRequestOrigin, mcpRequestOptions } from "./request-origin.ts";
import { McpMrtrError } from "./modern/errors.ts";
import { ensureMcpToolCallConnection } from "./health.ts";
import { isModernMcpClient } from "./modern/request.ts";

export interface McpResourceServer {
	readonly ensureFresh?: () => Promise<void>;
	readonly requestOrigin?: () => McpRequestOrigin | undefined;
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
	registerMcpNotificationHandler(client, ResourceUpdatedNotificationSchema, () => {
		onChange();
	});
}

/** Best-effort per-resource subscriptions when the server declares support. */
export async function ensureMcpResourceSubscriptions(
	client: Client,
	resources: ReadonlyArray<{ uri: string }>,
): Promise<void> {
	// Modern streams derive their resource URI filter from resources/list results.
	if (isModernMcpClient(client)) return;
	if (client.getServerCapabilities()?.resources?.subscribe !== true) return;
	await Promise.all(
		resources.map((resource) => client.subscribeResource({ uri: resource.uri }).catch(() => undefined)),
	);
}

/** Read one resource and flatten its contents to guarded text. */
export async function readMcpResourceAsText(
	server: McpResourceServer,
	uri: string,
	signal?: AbortSignal,
): Promise<string> {
	let contents: Awaited<ReturnType<Client["readResource"]>>["contents"];
	try {
		if (server.requestOrigin) await ensureMcpToolCallConnection(server.connection, server.ensureFresh);
		const result = await server.connection.client.readResource(
			{ uri },
			mcpRequestOptions(server.requestOrigin?.(), {
				timeout: server.requestTimeoutMs,
				...(signal === undefined ? {} : { signal }),
			}),
		);
		contents = result.contents;
	} catch (error) {
		if (error instanceof McpMrtrError) throw error;
		throw new ToolExecError(
			redactResolvedReferenceValues(
				`Failed to read MCP resource ${uri}: ${error instanceof Error ? error.message : String(error)}`,
			),
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
						`- @mcp:${entry.server}/${resource.uri} - ${resource.name ?? resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}`,
				),
			);
			const text = lines.length === 0 ? "No MCP resources available." : lines.join("\n");
			return {
				content: [{ type: "text", text: redactResolvedReferenceValues(text) }],
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
		async execute(_id, params: Static<typeof ReadParams>, signal) {
			const entry = servers().find((candidate) => candidate.server === params.server);
			if (entry === undefined) {
				throw new ToolExecError(
					redactResolvedReferenceValues(`Unknown MCP server '${params.server}' for resource ${params.uri}.`),
					{
						phase: "call",
						serverName: params.server,
					},
				);
			}
			const text = await readMcpResourceAsText(entry, params.uri, signal);
			return {
				content: [{ type: "text", text }],
				details: redactResolvedReferenceData({
					preview: params.uri,
					server: params.server,
					tool: "mcp_read_resource",
				}),
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
			if (
				error instanceof McpMrtrError &&
				["MCP_MRTR_CANCELLED", "MCP_MRTR_CONTEXT_CHANGED", "MCP_MRTR_TIMEOUT"].includes(error.code)
			) {
				notices.push("MCP resource request canceled; mention left unchanged.");
				continue;
			}
			notices.push(`@mcp mention left as-is: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const redacted = redactResolvedReferenceValues(expanded);
	return { changed: redacted !== text, notices: redactResolvedReferenceData(notices), text: redacted };
}
