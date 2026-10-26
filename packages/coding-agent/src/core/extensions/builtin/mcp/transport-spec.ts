import { AuthError, ConnectError } from "./errors.ts";
import type { CreateMcpTransportOptions } from "./transport.ts";
import type { McpStdioTransportSpec, McpTransportSpec } from "./transport-sdk.ts";

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function mcpTransportSpec(options: CreateMcpTransportOptions): McpTransportSpec {
	return options.config.type === "stdio" ? stdioSpec(options) : httpSpec(options);
}

function stdioSpec(options: CreateMcpTransportOptions): McpStdioTransportSpec {
	const command = options.config.command;
	if (command === undefined || command.trim().length === 0) {
		throw new ConnectError(`MCP server ${options.serverName} stdio command is required`, {
			phase: "create",
			serverName: options.serverName,
		});
	}
	return {
		args: options.config.args,
		authProvider: options.authProvider,
		command,
		cwd: options.config.cwd,
		env: { ...definedEnv(options.env), ...(options.config.env ?? {}) },
		kind: "stdio",
		projectPolicy: options.projectPolicy,
		resolveBeforeStart:
			options.resolveProjectPolicy === undefined
				? undefined
				: async () => {
						const current = await options.resolveProjectPolicy?.();
						if (current === undefined)
							throw new ConnectError("Project MCP policy is no longer available", {
								phase: "create",
								retriable: true,
								serverName: options.serverName,
							});
						return stdioSpec({ ...options, ...current, resolveProjectPolicy: undefined });
					},
	};
}

function httpSpec(options: CreateMcpTransportOptions): McpTransportSpec {
	if (options.config.url === undefined || options.config.url.trim().length === 0) {
		throw new ConnectError(`MCP server ${options.serverName} HTTP URL is required`, {
			phase: "create",
			serverName: options.serverName,
		});
	}
	let url: URL;
	try {
		url = new URL(options.config.url);
	} catch (error) {
		throw new ConnectError(`MCP server ${options.serverName} HTTP URL is invalid: ${errorMessage(error)}`, {
			cause: error,
			phase: "create",
			serverName: options.serverName,
		});
	}
	const headers = buildHeaders(options);
	return {
		authProvider: options.authProvider,
		kind: "http",
		requestInit: Object.keys(headers).length === 0 ? undefined : { headers },
		url,
	};
}

function definedEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function buildHeaders(options: CreateMcpTransportOptions): Record<string, string> {
	const headers = { ...(options.config.headers ?? {}) };
	const shouldAttachBearer =
		options.config.auth === "bearer" ||
		(options.config.auth === undefined && options.config.bearerTokenEnv !== undefined);
	if (!shouldAttachBearer) return headers;
	const envName = options.config.bearerTokenEnv;
	if (envName === undefined || envName.trim().length === 0) {
		throw new AuthError(`MCP server ${options.serverName} bearer auth requires bearerTokenEnv`, {
			phase: "create",
			serverName: options.serverName,
		});
	}
	const token = options.env?.[envName] ?? process.env[envName];
	if (token === undefined || token.length === 0) {
		throw new AuthError(`MCP server ${options.serverName} bearer token env ${envName} is not set`, {
			phase: "create",
			serverName: options.serverName,
		});
	}
	headers.authorization = `Bearer ${token}`;
	return headers;
}
