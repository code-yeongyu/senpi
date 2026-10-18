/**
 * SDK object construction for the transport layer.
 *
 * `transport.ts` validates a server config synchronously (its typed create
 * errors are part of the public contract) and describes the transport as a
 * plain spec; everything that needs a class out of
 * `@modelcontextprotocol/sdk` — the stdio/HTTP transports, the client, the
 * elicitation handler — is built here, behind `sdk.lazy.ts`, when the
 * connection is first materialized on the async connect path.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthProvider } from "./auth/oauth-provider.ts";
import {
	configureMcpElicitation,
	MCP_CLIENT_ELICITATION_CAPABILITY,
	type McpElicitationUiProvider,
} from "./elicitation.ts";
import type { McpLogger } from "./log.ts";
import { loadMcpSdkClient, loadMcpSdkStdioTransport, loadMcpSdkStreamableHttpTransport } from "./sdk.lazy.ts";
import { type McpAsyncErrorSink, safeOn } from "./wrap.ts";

export type McpStdioTransportSpec = {
	readonly kind: "stdio";
	readonly command: string;
	readonly args: string[] | undefined;
	readonly cwd: string | undefined;
	/** Config + caller env, already merged; the SDK default environment is layered underneath. */
	readonly env: Record<string, string>;
	readonly authProvider: McpOAuthProvider | undefined;
};

export type McpHttpTransportSpec = {
	readonly kind: "http";
	readonly url: URL;
	readonly authProvider: McpOAuthProvider | undefined;
	readonly requestInit: RequestInit | undefined;
};

export type McpTransportSpec = McpStdioTransportSpec | McpHttpTransportSpec;

export interface McpMaterializedTransport {
	readonly transport: Transport;
	readonly client: Client;
	/** Root pid of a stdio child, or null for HTTP and before start. */
	readPid(): number | null;
	close(): Promise<void>;
}

export interface MaterializeMcpTransportOptions {
	readonly spec: McpTransportSpec;
	readonly logger: McpLogger;
	readonly sink: McpAsyncErrorSink;
	readonly elicitationUiProvider: McpElicitationUiProvider | undefined;
	/** Invoked once the stdio child has started, so the caller can capture its pid. */
	readonly onStart: () => void;
}

export async function materializeMcpTransport(
	options: MaterializeMcpTransportOptions,
): Promise<McpMaterializedTransport> {
	const client = await buildMcpClient(options.elicitationUiProvider);
	if (options.spec.kind === "stdio") return materializeStdio(options.spec, options, client);
	return materializeHttp(options.spec, client);
}

async function materializeStdio(
	spec: McpStdioTransportSpec,
	options: MaterializeMcpTransportOptions,
	client: Client,
): Promise<McpMaterializedTransport> {
	const { getDefaultEnvironment, StdioClientTransport } = await loadMcpSdkStdioTransport();
	const transport = new StdioClientTransport({
		args: spec.args,
		command: spec.command,
		cwd: spec.cwd,
		env: { ...getDefaultEnvironment(), ...spec.env, ...oauthAccessTokenEnv(spec.authProvider) },
		stderr: "pipe",
	});
	trackStdioStart(transport, options.onStart);
	pipeStderr(transport, options.logger, options.sink);
	dropNullNextCursor(transport);
	return {
		client,
		close: () => closeClientAndTransport(transport, client),
		readPid: () => transport.pid,
		transport,
	};
}

async function materializeHttp(spec: McpHttpTransportSpec, client: Client): Promise<McpMaterializedTransport> {
	const { StreamableHTTPClientTransport } = await loadMcpSdkStreamableHttpTransport();
	const transport = new StreamableHTTPClientTransport(spec.url, {
		authProvider: spec.authProvider,
		requestInit: spec.requestInit,
	});
	dropNullNextCursor(transport);
	return {
		client,
		close: () => closeClientAndTransport(transport, client),
		readPid: () => null,
		transport,
	};
}

async function buildMcpClient(elicitationUiProvider: McpElicitationUiProvider | undefined): Promise<Client> {
	// Elicitation capability is declared EMPTY on purpose (form mode only;
	// Spring-AI servers reject richer shapes) and the create-handler is wired
	// before any connect so mid-call requests never race registration.
	const { Client: McpClient } = await loadMcpSdkClient();
	const client = new McpClient(
		{ name: "senpi-mcp-client", version: "0.0.0" },
		{ capabilities: MCP_CLIENT_ELICITATION_CAPABILITY },
	);
	await configureMcpElicitation(client, elicitationUiProvider);
	return client;
}

// OMP pattern: hand stdio OAuth servers the current access token via env.
function oauthAccessTokenEnv(authProvider: McpOAuthProvider | undefined): Record<string, string> {
	const accessToken = authProvider?.tokens()?.access_token;
	if (accessToken === undefined || accessToken.length === 0) return {};
	return { OAUTH_ACCESS_TOKEN: accessToken };
}

// Some servers end pagination with `nextCursor: null`; the SDK's result schemas accept only a string or no
// cursor, so the null is dropped before the client parses the result.
function dropNullNextCursor(transport: Transport): void {
	const originalStart = transport.start.bind(transport);
	transport.start = async () => {
		const deliver = transport.onmessage;
		if (deliver !== undefined) {
			transport.onmessage = (message, extra) => {
				if ("result" in message && message.result !== null && typeof message.result === "object") {
					const result = message.result as Record<string, unknown>;
					if (result.nextCursor === null) delete result.nextCursor;
				}
				deliver(message, extra);
			};
		}
		await originalStart();
	};
}

function trackStdioStart(transport: StdioClientTransport, onStart: () => void): void {
	const start = transport.start.bind(transport);
	transport.start = async () => {
		await start();
		onStart();
	};
}

function pipeStderr(transport: StdioClientTransport, logger: McpLogger, sink: McpAsyncErrorSink): void {
	let pending = "";
	const stderr = transport.stderr;
	if (stderr === undefined || stderr === null) return;
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

async function closeClientAndTransport(transport: Transport, client: Client): Promise<void> {
	if (isTerminableHttpTransport(transport)) {
		await transport.terminateSession().catch(() => undefined);
	}
	await transport.close().catch(() => undefined);
	await client.close().catch(() => undefined);
}

function isTerminableHttpTransport(
	transport: Transport,
): transport is Transport & { terminateSession(): Promise<void> } {
	return "terminateSession" in transport && typeof transport.terminateSession === "function";
}
