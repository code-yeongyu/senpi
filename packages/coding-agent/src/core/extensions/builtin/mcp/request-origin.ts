import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { McpMrtrPresentation } from "../../../mcp-mrtr-presentations.ts";
import type { ServerConnection } from "./connection.ts";
import { McpMrtrError } from "./modern/errors.ts";

const originOption = Symbol("mcp-request-origin");
const origins = new WeakSet<object>();
const aliases = new WeakMap<Client, Client>();
export const physicalMcpClient = (client: Client): Client => aliases.get(client) ?? client;

export function registerMcpClientAlias(alias: Client, physical: Client): void {
	aliases.set(alias, physical);
}

export interface McpRequestOrigin {
	readonly binding: object;
	readonly connection: ServerConnection;
	readonly signal: AbortSignal;
	readonly presentation?: McpMrtrPresentation;
	readonly serverLabel: string;
	readonly isCurrent: () => boolean;
	readonly resolveAuthority: (signal: AbortSignal) => Promise<unknown>;
}

/** Issued by the binding-specific registration boundary, never from JSON/model arguments. */
export function createMcpRequestOrigin(origin: McpRequestOrigin): McpRequestOrigin {
	origins.add(origin);
	return origin;
}

export function mcpRequestOptions(
	origin: McpRequestOrigin | undefined,
	options: RequestOptions = {},
): RequestOptions & { [originOption]?: McpRequestOrigin } {
	return origin === undefined ? options : { ...options, [originOption]: origin };
}

export function takeMcpRequestOrigin(options: RequestOptions | undefined, client: Client) {
	const supplied = options as (RequestOptions & { [originOption]?: McpRequestOrigin }) | undefined;
	const origin = supplied?.[originOption];
	const { [originOption]: _origin, ...sdkOptions } = supplied ?? {};
	if (origin !== undefined) {
		if (!origins.has(origin) || !origin.isCurrent()) throw new McpMrtrError("MCP_MRTR_CONTEXT_CHANGED");
		const candidate = origin.connection.client;
		if (physicalMcpClient(candidate) !== client) throw new McpMrtrError("MCP_MRTR_CONTEXT_CHANGED");
	}
	return { origin, sdkOptions };
}
