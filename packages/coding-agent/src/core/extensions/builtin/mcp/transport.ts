import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthProvider } from "./auth/oauth-provider.ts";
import type { McpServerConfig } from "./config-schema.ts";
import { AuthError, ConnectError, TimeoutError } from "./errors.ts";
import type { McpLogger } from "./log.ts";
import { delay, reapProcessTree } from "./process-tree.ts";
import { type McpAsyncErrorSink, safeInterval, safeOn, safeTimer } from "./wrap.ts";

export type McpTransportKind = "stdio" | "http";

export type McpTransportConnection = {
	readonly serverName: string;
	readonly client: Client;
	readonly transport: Transport;
	readonly transportKind: McpTransportKind;
	readonly connectTimeoutMs: number;
	readonly asyncErrorSink: McpAsyncErrorSink;
	captureRootPid?(): void;
	getRootPid(): number | null;
};

export type CreateMcpTransportOptions = {
	readonly serverName: string;
	readonly config: McpServerConfig;
	readonly logger: McpLogger;
	readonly env?: Record<string, string | undefined>;
	// Present only when OAuth is the resolved auth mode for this server.
	readonly authProvider?: McpOAuthProvider;
};

const SHUTDOWN_GRACE_MS = 100,
	SHUTDOWN_TERM_WAIT_MS = 400;
const SHUTDOWN_FINAL_WAIT_MS = 500,
	SHUTDOWN_CLOSE_WAIT_MS = 400;

export function createMcpTransport(options: CreateMcpTransportOptions): McpTransportConnection {
	const connectTimeoutMs = options.config.connectTimeoutMs ?? 15_000;
	if (options.config.type === "stdio") return createStdioConnection(options, connectTimeoutMs);
	return createHttpConnection(options, connectTimeoutMs);
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
		await connection.client.connect(connection.transport, {
			signal: controller.signal,
			timeout: connection.connectTimeoutMs,
		});
	} catch (error) {
		await shutdownMcpTransport(connection).catch((shutdownError: unknown) => ignoreShutdownError(shutdownError));
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
	const closePromise = closeClientAndTransport(connection);
	await delay(SHUTDOWN_GRACE_MS);

	if (rootPid !== null) {
		await reapProcessTree(rootPid, {
			killWaitMs: SHUTDOWN_FINAL_WAIT_MS,
			termWaitMs: SHUTDOWN_TERM_WAIT_MS,
		});
	}
	await Promise.race([closePromise, delay(SHUTDOWN_CLOSE_WAIT_MS)]);
}

function createStdioConnection(options: CreateMcpTransportOptions, connectTimeoutMs: number): McpTransportConnection {
	const command = options.config.command;
	if (command === undefined || command.trim().length === 0) {
		throw new ConnectError(`MCP server ${options.serverName} stdio command is required`, {
			phase: "create",
			serverName: options.serverName,
		});
	}
	const transport = new StdioClientTransport({
		args: options.config.args,
		command,
		cwd: options.config.cwd,
		env: buildStdioEnv(options),
		stderr: "pipe",
	});
	const asyncErrorSink: McpAsyncErrorSink = { logger: options.logger };
	pipeStderr(transport, options.logger);
	return createConnection(options.serverName, "stdio", transport, connectTimeoutMs, asyncErrorSink);
}

function createHttpConnection(options: CreateMcpTransportOptions, connectTimeoutMs: number): McpTransportConnection {
	const rawUrl = options.config.url;
	if (rawUrl === undefined || rawUrl.trim().length === 0) {
		throw new ConnectError(`MCP server ${options.serverName} HTTP URL is required`, {
			phase: "create",
			serverName: options.serverName,
		});
	}
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch (error) {
		throw new ConnectError(`MCP server ${options.serverName} HTTP URL is invalid: ${errorMessage(error)}`, {
			cause: error,
			phase: "create",
			serverName: options.serverName,
		});
	}
	const headers = buildHeaders(options);
	const transport = new StreamableHTTPClientTransport(url, {
		authProvider: options.authProvider,
		requestInit: Object.keys(headers).length === 0 ? undefined : { headers },
	});
	return createConnection(options.serverName, "http", transport, connectTimeoutMs, { logger: options.logger });
}

function createConnection(
	serverName: string,
	transportKind: McpTransportKind,
	transport: Transport,
	connectTimeoutMs: number,
	asyncErrorSink: McpAsyncErrorSink,
): McpTransportConnection {
	let lastRootPid: number | null = null;
	const readRootPid = (): number | null => (transport instanceof StdioClientTransport ? transport.pid : null);
	const captureRootPid = (): void => {
		lastRootPid = readRootPid() ?? lastRootPid;
	};
	if (transport instanceof StdioClientTransport) trackStdioStart(transport, captureRootPid);
	return {
		captureRootPid,
		client: new Client({ name: "senpi-mcp-client", version: "0.0.0" }),
		connectTimeoutMs,
		asyncErrorSink,
		getRootPid: () => {
			captureRootPid();
			return readRootPid() ?? lastRootPid;
		},
		serverName,
		transport,
		transportKind,
	};
}

function trackStdioStart(transport: StdioClientTransport, captureRootPid: () => void): void {
	const start = transport.start.bind(transport);
	transport.start = async () => {
		await start();
		captureRootPid();
	};
}

function buildStdioEnv(options: CreateMcpTransportOptions): Record<string, string> {
	const env: Record<string, string> = {
		...getDefaultEnvironment(),
		...definedEnv(options.env),
		...(options.config.env ?? {}),
	};
	// OMP pattern: hand stdio OAuth servers the current access token via env.
	const accessToken = options.authProvider?.tokens()?.access_token;
	if (accessToken !== undefined && accessToken.length > 0) env.OAUTH_ACCESS_TOKEN = accessToken;
	return env;
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
	if (options.config.auth !== "bearer") return headers;
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

function pipeStderr(transport: StdioClientTransport, logger: McpLogger): void {
	let pending = "";
	const stderr = transport.stderr;
	if (stderr === undefined || stderr === null) return;
	const sink: McpAsyncErrorSink = { logger };
	safeOn(
		stderr,
		"data",
		"transport.stderr.data",
		(chunk) => {
			if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") return;
			pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line.length > 0) logger.stderr(line);
			}
		},
		sink,
	);
	safeOn(
		stderr,
		"end",
		"transport.stderr.end",
		() => {
			if (pending.length > 0) logger.stderr(pending);
			pending = "";
		},
		sink,
	);
}

async function closeClientAndTransport(connection: McpTransportConnection): Promise<void> {
	if (isTerminableHttpTransport(connection.transport)) {
		await connection.transport.terminateSession().catch((error: unknown) => ignoreShutdownError(error));
	}
	await connection.transport.close().catch((error: unknown) => ignoreShutdownError(error));
	await connection.client.close().catch((error: unknown) => ignoreShutdownError(error));
}

function isTerminableHttpTransport(transport: Transport): transport is Transport & TerminableHttpTransport {
	return typeof (transport as Partial<TerminableHttpTransport>).terminateSession === "function";
}

interface TerminableHttpTransport {
	terminateSession(): Promise<void>;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function ignoreShutdownError(error: unknown): void {
	void error;
}
