import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { McpMrtrPresentation } from "../../../mcp-mrtr-presentations.ts";
import type { McpFormPresentation } from "../../../mcp-form-types.ts";
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
	readonly privateForm?: McpFormPresentation;
	readonly privateFormsEnforced?: boolean;
	readonly serverLabel: string;
	readonly serverSource?: "user" | "project" | "plugin";
	readonly isCurrent: () => boolean;
	readonly resolveAuthority: (signal: AbortSignal) => Promise<unknown>;
}

const legacyOperations = new WeakMap<
	Client,
	Set<{ readonly origin: McpRequestOrigin; readonly signal: AbortSignal }>
>();
export function beginLegacyMcpOperation(client: Client, origin: McpRequestOrigin, caller?: AbortSignal): () => void {
	const lifetime = new AbortController();
	const operation = {
		origin,
		signal: AbortSignal.any([origin.signal, lifetime.signal, ...(caller ? [caller] : [])]),
	};
	let operations = legacyOperations.get(client);
	if (!operations) {
		operations = new Set();
		legacyOperations.set(client, operations);
	}
	operations.add(operation);
	return () => {
		operations.delete(operation);
		lifetime.abort();
		if (operations.size === 0) legacyOperations.delete(client);
	};
}
export function legacyMcpOperation(client: Client) {
	const operations = legacyOperations.get(client);
	if (operations && operations.size > 1) return "ambiguous";
	if (operations?.size !== 1) return undefined;
	const operation = operations.values().next().value;
	return operation && !operation.signal.aborted && operation.origin.isCurrent() ? operation : undefined;
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
