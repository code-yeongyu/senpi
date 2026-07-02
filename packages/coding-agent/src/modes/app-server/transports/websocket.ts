import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { getAgentDir } from "../../../config.ts";
import type { RpcEnvelope } from "../rpc/envelope.ts";
import { parseNdjsonLine, serializeNdjsonMessage } from "../rpc/ndjson.ts";
import { ServerCore } from "../server/server-core.ts";

export type WebSocketListenerAuth =
	| { readonly kind: "off" }
	| { readonly kind: "token-file"; readonly path: string }
	| { readonly kind: "token-value"; readonly token: string };

export interface WebSocketListenerOptions {
	readonly host: string;
	readonly port: number;
	readonly auth?: WebSocketListenerAuth;
	readonly core?: ServerCore;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
	readonly outboundQueueBytes?: number;
}

export interface WebSocketListenerHandle {
	readonly host: string;
	readonly port: number;
	readonly core: ServerCore;
	readonly tokenFile: string | undefined;
	readonly connectionCount: number;
	close(): Promise<void>;
}

type ResolvedAuth =
	| { readonly kind: "off" }
	| { readonly kind: "bearer"; readonly token: string; readonly path?: string };

const DEFAULT_OUTBOUND_QUEUE_BYTES = 16 * 1024 * 1024;
const WEBSOCKET_RETRY_LATER = 1013;

export class AppServerWebSocketListenError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = "AppServerWebSocketListenError";
	}
}

export async function startAppServerWebSocketListener(
	options: WebSocketListenerOptions,
): Promise<WebSocketListenerHandle> {
	const auth = await resolveAuth(options.auth, options.stderr ?? process.stderr);
	if (auth.kind === "off" && !isLoopbackHost(options.host)) {
		throw new AppServerWebSocketListenError("Refusing unauthenticated app-server websocket on non-loopback host.");
	}

	const core = options.core ?? new ServerCore();
	const wss = new WebSocketServer({ noServer: true });
	const connections = new Set<WebSocket>();
	let nextConnectionId = 1;
	let accepting = true;
	const server = createServer((request, response) => {
		handleHttpRequest(request, response, accepting);
	});

	server.on("upgrade", (request, socket, head) => {
		if (hasOrigin(request)) {
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}
		if (request.url !== "/") {
			rejectUpgrade(socket, 400, "Bad Request");
			return;
		}
		if (!authorized(request, auth)) {
			rejectUpgrade(socket, 401, "Unauthorized");
			return;
		}
		wss.handleUpgrade(request, socket, head, (websocket) => {
			const connectionId = `ws-${nextConnectionId}`;
			nextConnectionId += 1;
			connections.add(websocket);
			core.addConnection({
				id: connectionId,
				transportKind: "websocket",
				send: (message) => sendWebSocketMessage(websocket, message, options.outboundQueueBytes),
				close: () => {
					websocket.close(WEBSOCKET_RETRY_LATER, "slow-client");
				},
			});
			websocket.on("message", (data, isBinary) => {
				if (isBinary) return;
				const parsed = parseNdjsonLine(data.toString("utf8"));
				if (parsed.kind === "parse-error") {
					void sendWebSocketMessage(websocket, parsed.message, options.outboundQueueBytes);
					return;
				}
				void core.receive(connectionId, parsed);
			});
			websocket.on("close", () => {
				connections.delete(websocket);
				core.removeConnection(connectionId);
			});
		});
	});

	await listen(server, options.host, options.port);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new AppServerWebSocketListenError("Websocket listener did not bind to a TCP address.");
	}

	return {
		host: options.host,
		port: address.port,
		core,
		tokenFile: auth.kind === "bearer" ? auth.path : undefined,
		get connectionCount() {
			return connections.size;
		},
		async close() {
			accepting = false;
			for (const websocket of connections) {
				websocket.close();
			}
			await closeServer(wss);
			await closeServer(server);
		},
	};
}

function handleHttpRequest(request: IncomingMessage, response: ServerResponse, accepting: boolean): void {
	if (hasOrigin(request)) {
		writeText(response, 403, "forbidden\n");
		return;
	}
	if ((request.url === "/readyz" || request.url === "/healthz") && accepting) {
		writeText(response, 200, "ok\n");
		return;
	}
	writeText(response, 400, "websocket upgrade required\n");
}

async function resolveAuth(
	auth: WebSocketListenerAuth | undefined,
	stderr: Pick<NodeJS.WriteStream, "write">,
): Promise<ResolvedAuth> {
	if (auth?.kind === "off") {
		return { kind: "off" };
	}
	if (auth?.kind === "token-value") {
		return { kind: "bearer", token: auth.token };
	}
	const path = auth?.path ?? join(getAgentDir(), "app-server", "ws-token");
	const token = auth?.kind === "token-file" ? await readTokenFile(path) : await ensureTokenFile(path);
	stderr.write(`app-server websocket token: ${path}\n`);
	return { kind: "bearer", token, path };
}

async function readTokenFile(path: string): Promise<string> {
	return (await readFile(path, "utf8")).trim();
}

async function ensureTokenFile(path: string): Promise<string> {
	try {
		return await readTokenFile(path);
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ENOENT")) throw error;
	}
	const token = randomBytes(32).toString("hex");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${token}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return token;
}

function authorized(request: IncomingMessage, auth: ResolvedAuth): boolean {
	if (auth.kind === "off") {
		return true;
	}
	const header = request.headers.authorization;
	if (typeof header !== "string" || !header.startsWith("Bearer ")) {
		return false;
	}
	return tokensEqual(header.slice("Bearer ".length), auth.token);
}

function tokensEqual(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function sendWebSocketMessage(
	websocket: WebSocket,
	message: RpcEnvelope,
	outboundQueueBytes = DEFAULT_OUTBOUND_QUEUE_BYTES,
): Promise<void> {
	const payload = serializeNdjsonMessage(message).trimEnd();
	if (websocket.bufferedAmount + Buffer.byteLength(payload) > outboundQueueBytes) {
		const closed = waitForSocketClose(websocket);
		websocket.close(WEBSOCKET_RETRY_LATER, "slow-client");
		return closed;
	}
	return new Promise((resolve, reject) => {
		websocket.send(payload, (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function waitForSocketClose(websocket: WebSocket): Promise<void> {
	if (websocket.readyState === WebSocket.CLOSED) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		websocket.once("close", () => resolve());
	});
}

function hasOrigin(request: IncomingMessage): boolean {
	return request.headers.origin !== undefined;
}

function writeText(response: ServerResponse, statusCode: number, body: string): void {
	response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
	response.end(body);
}

function rejectUpgrade(socket: Duplex, statusCode: 400 | 401 | 403, reason: string): void {
	socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}

function listen(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Pick<Server | WebSocketServer, "close">): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isLoopbackHost(host: string): boolean {
	return host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}
