import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionToolContext } from "../../types.ts";
import { authorizeToolDispatch, type DispatchIdentity, hasDispatchAuthorizer } from "../permission-system/dispatch.ts";
import { getDispatchIdentity } from "../permission-system/dispatch-metadata.ts";
import type { McpToolCatalogEntry } from "./catalog.ts";
import { TimeoutError } from "./errors.ts";

export interface McpInvocation {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly context?: ExtensionToolContext;
}

export interface McpInvocationError {
	readonly kind: "unavailable" | "schema_changed" | "permission_denied";
	readonly server: string;
	readonly tool: string;
	readonly message: string;
	readonly currentDefinition?: McpToolCatalogEntry["schema"];
}

export type McpPreparedInvocation =
	| { readonly kind: "ready"; readonly entry: McpToolCatalogEntry; readonly isCurrent: () => boolean }
	| { readonly kind: "refused"; readonly error: McpInvocationError };

export interface McpInvocationResolver {
	identity(entry: McpToolCatalogEntry): DispatchIdentity;
	resolve(
		entry: McpToolCatalogEntry,
		args: Record<string, unknown>,
		invocation: McpInvocation | undefined,
		signal: AbortSignal | undefined,
	): Promise<McpPreparedInvocation>;
}

interface InvocationScope {
	readonly owner: object;
	readonly configuration: string;
	readonly contextRequired: boolean;
	readonly sessionManager?: object;
	readonly isCurrent: () => boolean;
	readonly ready: () => Promise<void>;
	readonly current: (tool: string) => McpToolCatalogEntry | undefined;
}

export function createMcpInvocationResolver(scope: InvocationScope): McpInvocationResolver {
	const identity = (entry: McpToolCatalogEntry): DispatchIdentity => ({
		owner: scope.owner,
		operation: JSON.stringify([entry.server, entry.tool]),
		metadata: JSON.stringify([
			scope.configuration,
			entry.server,
			entry.tool,
			entry.schema,
			entry.description,
			entry.annotations,
		]),
	});
	return {
		identity,
		async resolve(offered, args, invocation, signal) {
			const refuse = (kind: McpInvocationError["kind"], message: string, current?: McpToolCatalogEntry) => ({
				kind: "refused" as const,
				error: {
					kind,
					message,
					server: offered.server,
					tool: offered.tool,
					currentDefinition: current?.schema,
				},
			});
			signal?.throwIfAborted();
			if (!scope.isCurrent()) return refuse("unavailable", "MCP session or server configuration was replaced.");
			const ctx = invocation?.context;
			if (
				scope.contextRequired &&
				(ctx === undefined || (scope.sessionManager !== undefined && ctx.sessionManager !== scope.sessionManager))
			) {
				return refuse("unavailable", "MCP invocation does not belong to this session.");
			}
			const deadline = new AbortController();
			const timeout = setTimeout(
				() =>
					deadline.abort(
						new TimeoutError("MCP metadata was not ready before the request timeout.", {
							phase: "catalog",
							serverName: offered.server,
						}),
					),
				offered.requestTimeoutMs,
			);
			const readySignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
			const ready = scope.ready();
			let abort: () => void = () => {};
			const interrupted = new Promise<never>((_resolve, reject) => {
				abort = () => reject(readySignal.reason);
				readySignal.addEventListener("abort", abort, { once: true });
				if (readySignal.aborted) abort();
			});
			try {
				await Promise.race([ready, interrupted]);
			} finally {
				clearTimeout(timeout);
				readySignal.removeEventListener("abort", abort);
			}
			signal?.throwIfAborted();
			if (!scope.isCurrent()) return refuse("unavailable", "MCP session or server configuration was replaced.");
			const current = scope.current(offered.tool);
			if (current === undefined) return refuse("unavailable", "MCP tool is no longer available.");
			// Validate the current raw schema, never the coercing preflight schema.
			if (!Check(Type.Unsafe(current.schema), args)) {
				return refuse("schema_changed", "Arguments do not match the current MCP tool schema.", current);
			}
			const preparedIdentity = identity(current);
			let permissionFence: (() => boolean) | undefined;
			let operationFence: (() => boolean) | undefined;
			if (
				ctx !== undefined &&
				invocation !== undefined &&
				(scope.contextRequired || ctx.sessionManager !== undefined)
			) {
				operationFence = () => {
					const registered = ctx.tools.find((tool) => tool.name === invocation.toolName);
					const registeredIdentity =
						registered === undefined ? undefined : getDispatchIdentity(registered.parameters, invocation.input);
					return (
						registeredIdentity?.owner === preparedIdentity.owner &&
						registeredIdentity.operation === preparedIdentity.operation
					);
				};
				if (!operationFence()) {
					return refuse("unavailable", "MCP invocation name no longer identifies this operation.", current);
				}
				if (hasDispatchAuthorizer(ctx.sessionManager)) {
					try {
						permissionFence = await authorizeToolDispatch(
							ctx.sessionManager,
							{ ...invocation, identity: preparedIdentity },
							ctx,
							signal,
						);
					} catch (error) {
						signal?.throwIfAborted();
						return refuse("permission_denied", error instanceof Error ? error.message : String(error), current);
					}
				} else if (
					ctx.loadedExtensionPaths === undefined ||
					ctx.loadedExtensionPaths.some((path) => path.includes("permission-system"))
				) {
					return refuse("permission_denied", "Permission authorizer is unavailable.", current);
				}
			}
			return {
				kind: "ready",
				entry: current,
				isCurrent: () => {
					if (signal?.aborted || !scope.isCurrent()) return false;
					const latest = scope.current(offered.tool);
					return (
						latest !== undefined &&
						identity(latest).metadata === preparedIdentity.metadata &&
						Check(Type.Unsafe(latest.schema), args) &&
						(operationFence === undefined || operationFence()) &&
						(permissionFence === undefined || permissionFence())
					);
				},
			};
		},
	};
}
