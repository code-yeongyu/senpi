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
import type { McpElicitationUiProvider } from "./elicitation.ts";
import type { McpLogger } from "./log.ts";
import { modernCredentialSnapshot } from "./modern/http-fetch.ts";
import { createMcpRequestClient } from "./modern/client.ts";
import type { ModernProtocolState } from "./modern/request.ts";
import { ProjectStdioTransport } from "./project-stdio-transport.ts";
import { loadMcpSdkStdioTransport, loadMcpSdkStreamableHttpTransport } from "./sdk.lazy.ts";
import { type McpAsyncErrorSink, safeOn } from "./wrap.ts";

export type McpStdioTransportSpec = {
	readonly projectPolicy?: boolean;
	readonly resolveBeforeStart?: () => Promise<McpStdioTransportSpec>;
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
	readonly elicitationEnabled?: boolean;
	/** Invoked once the stdio child has started, so the caller can capture its pid. */
	readonly onStart: () => void;
}

export async function materializeMcpTransport(
	options: MaterializeMcpTransportOptions,
	protocol: ModernProtocolState = {},
): Promise<McpMaterializedTransport> {
	const client = await createMcpRequestClient(
		protocol,
		options.elicitationUiProvider,
		() => modernCredentialSnapshot(options.spec.authProvider?.tokens()),
		options.elicitationEnabled,
	);
	if (options.spec.kind === "stdio") return materializeStdio(options.spec, options, client, protocol);
	return materializeHttp(options.spec, client);
}

async function materializeStdio(
	spec: McpStdioTransportSpec,
	options: MaterializeMcpTransportOptions,
	client: Client,
	protocol: ModernProtocolState,
): Promise<McpMaterializedTransport> {
	const { getDefaultEnvironment, StdioClientTransport } = await loadMcpSdkStdioTransport();
	const create = (current: McpStdioTransportSpec) =>
		new StdioClientTransport({
			args: current.args,
			command: current.command,
			cwd: current.cwd,
			env: {
				...(current.projectPolicy ? {} : getDefaultEnvironment()),
				...current.env,
				...oauthAccessTokenEnv(current.authProvider),
			},
			stderr: "pipe",
		});
	const transport =
		spec.projectPolicy && spec.resolveBeforeStart !== undefined
			? new ProjectStdioTransport(spec.resolveBeforeStart, create)
			: create(spec);
	trackStdioStart(transport, options.onStart);
	pipeStderr(transport, options.logger, options.sink, protocol);
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

function trackStdioStart(transport: Pick<StdioClientTransport, "start">, onStart: () => void): void {
	const start = transport.start.bind(transport);
	transport.start = async () => {
		await start();
		onStart();
	};
}

function pipeStderr(
	transport: Pick<StdioClientTransport, "stderr">,
	logger: McpLogger,
	sink: McpAsyncErrorSink,
	protocol: ModernProtocolState,
): void {
	let pending = "";
	let undecided = "";
	let stderrEnded = false;
	const stderr = transport.stderr;
	if (stderr === undefined || stderr === null) return;
	const logLine = (line: string) => {
		// Arbitrary server text may echo private messages, schemas, or answers. Keep diagnostic
		// events and allowlisted system error codes, never untrusted payload text under enforcement.
		const code = protocol.privateForms
			? line.match(/\b(?:EACCES|ENOENT|EPIPE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOSPC|ENOMEM|EMFILE)\b/)?.[0]
			: undefined;
		logger.stderr(protocol.privateForms ? `[private MCP stderr redacted]${code ? ` ${code}` : ""}` : line);
	};
	const append = (text: string) => {
		pending += text;
		const lines = pending.split(/\r?\n/);
		pending = lines.pop() ?? "";
		for (const line of lines) if (line.length > 0) logLine(line);
	};
	protocol.resolveStdioDiagnostics = (modern) => {
		if (!modern || protocol.privateForms) {
			append(undecided);
			if (stderrEnded && pending.length > 0) {
				logLine(pending);
				pending = "";
			}
		}
		undecided = "";
		if (modern && !protocol.privateForms) pending = "";
	};
	safeOn(
		stderr,
		"data",
		"transport.stderr.data",
		(chunk) => {
			if (protocol.version !== undefined && !protocol.privateForms) {
				pending = "";
				undecided = "";
				return;
			}
			if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") return;
			const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
			if (!protocol.legacy && !protocol.privateForms) {
				// Only legacy-positive negotiation may release startup diagnostics.
				undecided += text.slice(0, Math.max(0, 512 * 1024 - undecided.length));
				return;
			}
			append(text);
		},
		sink,
	);
	safeOn(
		stderr,
		"end",
		"transport.stderr.end",
		() => {
			stderrEnded = true;
			if ((protocol.privateForms || (protocol.legacy && protocol.version === undefined)) && pending.length > 0)
				logLine(pending);
			pending = "";
			// A crashed probe is classified after EOF; only that decision may release or discard its buffer.
			if (protocol.legacy || protocol.version !== undefined) undecided = "";
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
