import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { McpMrtrPresentation } from "../../../mcp-mrtr-presentations.ts";
import type { McpFormPresentation } from "../../../mcp-form-types.ts";
import type { ExtensionUIContext } from "../../types.ts";
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
	/** The execution scope whose call made this request, when its binding serves several (brain/hand S16c). */
	readonly scope?: object;
	readonly elicitationUi?: () => Pick<ExtensionUIContext, "input" | "select"> | undefined;
	readonly isCurrent: () => boolean;
	readonly resolveAuthority: (signal: AbortSignal) => Promise<unknown>;
}

/** A request's origin, resolved for the context of the call that makes it (absent for prompts and resources). */
export type McpRequestOriginFor = (caller?: { readonly sessionManager?: object }) => McpRequestOrigin | undefined;

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

// Tool calls of a binding that serves several execution scopes, by physical client (brain/hand S16c). Kept apart
// from the legacy operations above: a default legacy client never routes its calls through the request adapter.
const scopedCalls = new WeakMap<Client, Set<{ readonly origin: McpRequestOrigin; readonly signal?: AbortSignal }>>();

/** Record a scoped tool call in flight on `client` until the returned function runs; an unscoped origin records none. */
export function beginScopedMcpCall(client: Client, origin: McpRequestOrigin, signal?: AbortSignal): () => void {
	if (origin.scope === undefined) return () => undefined;
	const physical = physicalMcpClient(client);
	const call = { origin, signal };
	let calls = scopedCalls.get(physical);
	if (!calls) {
		calls = new Set();
		scopedCalls.set(physical, calls);
	}
	calls.add(call);
	return () => {
		calls.delete(call);
		if (calls.size === 0) scopedCalls.delete(physical);
	};
}

/**
 * Whose UI a legacy form arriving on `client` belongs to: the one scope whose calls are in flight there, or
 * `"refuse"` when calls of different scopes share it. Without scoped calls the caller keeps its own provider.
 */
export function legacyMcpCallerUi(client: Client) {
	const calls = [...(scopedCalls.get(physicalMcpClient(client)) ?? [])].filter(
		(call) => call.signal?.aborted !== true && !call.origin.signal.aborted && call.origin.isCurrent(),
	);
	const scopes = new Set(calls.map((call) => call.origin.scope));
	if (scopes.size === 0) return undefined;
	if (scopes.size > 1) return "refuse";
	return { ui: calls[0]?.origin.elicitationUi?.() };
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
