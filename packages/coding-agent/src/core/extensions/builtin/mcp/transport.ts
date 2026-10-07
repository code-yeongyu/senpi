import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthProvider } from "./auth/oauth-provider.ts";
import type { McpServerConfig } from "./config-schema.ts";
import type { McpElicitationUiProvider } from "./elicitation.ts";
import { AuthError, ConnectError, TimeoutError } from "./errors.ts";
import type { McpLogger } from "./log.ts";
import { delay, reapProcessTree } from "./process-tree.ts";
import { type McpMaterializedTransport, type McpTransportSpec, materializeMcpTransport } from "./transport-sdk.ts";
import { type McpAsyncErrorSink, safeInterval, safeTimer } from "./wrap.ts";

export type McpTransportConnection = {
	readonly serverName: string;
	readonly client: Client;
	readonly transport: Transport;
	readonly transportKind: "stdio" | "http";
	readonly connectTimeoutMs: number;
	readonly asyncErrorSink: McpAsyncErrorSink;
	/**
	 * Loads the SDK and builds the transport + client. Idempotent and
	 * single-flight; `client`/`transport` throw until it has resolved.
	 */
	materialize(): Promise<void>;
	captureRootPid?(): void;
	getRootPid(): number | null;
	closeTransport(): Promise<void>;
};

export type CreateMcpTransportOptions = {
	readonly serverName: string;
	readonly config: McpServerConfig;
	readonly logger: McpLogger;
	readonly env?: Record<string, string | undefined>;
	readonly elicitationUiProvider?: McpElicitationUiProvider;
	// Present only when OAuth is the resolved auth mode for this server.
	readonly authProvider?: McpOAuthProvider;
};

const SHUTDOWN_GRACE_MS = 100,
	SHUTDOWN_TERM_WAIT_MS = 400,
	SHUTDOWN_FINAL_WAIT_MS = 500,
	SHUTDOWN_CLOSE_WAIT_MS = 400;

export function createMcpTransport(options: CreateMcpTransportOptions): McpTransportConnection {
	const spec = options.config.type === "stdio" ? stdioSpec(options) : httpSpec(options);
	return createConnection(options, spec, options.config.connectTimeoutMs);
}

export async function connectMcpTransport(connection: McpTransportConnection): Promise<void> {
	let timedOut = false;
	const controller = new AbortController();
	const captureInterval = safeInterval(
		"transport.captureRootPid",
		25,
		() => connection.captureRootPid?.(),
		connection.asyncErrorSink,
	);
	const timeout = safeTimer(
		"transport.connectTimeout",
		connection.connectTimeoutMs,
		() => {
			timedOut = true;
			connection.captureRootPid?.();
			controller.abort();
		},
		connection.asyncErrorSink,
	);
	try {
		await connection.materialize();
		await connection.client.connect(connection.transport, {
			signal: controller.signal,
			timeout: connection.connectTimeoutMs,
		});
	} catch (error) {
		await shutdownMcpTransport(connection).catch(() => undefined);
		if (timedOut) {
			throw new TimeoutError(
				`MCP server ${connection.serverName} timed out during connect after ${connection.connectTimeoutMs}ms`,
				{ cause: error, phase: "connect", retriable: true, serverName: connection.serverName },
			);
		}
		throw new ConnectError(`MCP server ${connection.serverName} failed during connect: ${errorMessage(error)}`, {
			cause: error,
			phase: "connect",
			retriable: true,
			serverName: connection.serverName,
		});
	} finally {
		clearInterval(captureInterval);
		clearTimeout(timeout);
	}
}

export async function shutdownMcpTransport(connection: McpTransportConnection): Promise<void> {
	const rootPid = connection.getRootPid();
	const closePromise = connection.closeTransport();
	await delay(SHUTDOWN_GRACE_MS);

	if (rootPid !== null) {
		await reapProcessTree(rootPid, {
			killWaitMs: SHUTDOWN_FINAL_WAIT_MS,
			termWaitMs: SHUTDOWN_TERM_WAIT_MS,
		});
	}
	await Promise.race([closePromise, delay(SHUTDOWN_CLOSE_WAIT_MS)]);
}

function stdioSpec(options: CreateMcpTransportOptions): McpTransportSpec {
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

function createConnection(
	options: CreateMcpTransportOptions,
	spec: McpTransportSpec,
	connectTimeoutMs: number,
): McpTransportConnection {
	const asyncErrorSink: McpAsyncErrorSink = { logger: options.logger };
	let materialized: McpMaterializedTransport | undefined;
	let pending: Promise<McpMaterializedTransport> | undefined;
	let lastRootPid: number | null = null;
	const captureRootPid = (): void => {
		lastRootPid = materialized?.readPid() ?? lastRootPid;
	};
	const built = (): McpMaterializedTransport => {
		if (materialized === undefined) {
			throw new ConnectError(`MCP server ${options.serverName} transport is not started`, {
				phase: "create",
				serverName: options.serverName,
			});
		}
		return materialized;
	};
	return {
		asyncErrorSink,
		captureRootPid,
		get client(): Client {
			return built().client;
		},
		closeTransport: async (): Promise<void> => {
			await materialized?.close();
		},
		connectTimeoutMs,
		getRootPid: (): number | null => {
			captureRootPid();
			return materialized?.readPid() ?? lastRootPid;
		},
		materialize: async (): Promise<void> => {
			pending ??= materializeMcpTransport({
				elicitationUiProvider: options.elicitationUiProvider,
				logger: options.logger,
				onStart: captureRootPid,
				sink: asyncErrorSink,
				spec,
			});
			materialized = await pending;
		},
		serverName: options.serverName,
		get transport(): Transport {
			return built().transport;
		},
		transportKind: spec.kind,
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

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
