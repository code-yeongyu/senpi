import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { BRIDGE_SERVER_NAME } from "./constants.ts";

export type BridgeTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

export type BridgeCallResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError: boolean;
};

export type BridgeSessionHandlers = {
	listTools(): readonly BridgeTool[];
	callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeCallResult>;
};

type BridgeSession = {
	handlers: BridgeSessionHandlers;
	controllers: Set<AbortController>;
};

type AuthorizedSession = {
	token: string;
	session: BridgeSession;
};

type BodyResult = { kind: "ok"; body: string } | { kind: "too-large" } | { kind: "aborted" };

const HOST = "127.0.0.1";
const PATH = "/mcp";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const LARGE_HEADERS_TIMEOUT_MS = 2_147_483_647;

const sessions = new Map<string, BridgeSession>();
const sockets = new Set<Socket>();
let server: Server | undefined;
let serverUrl: string | undefined;
let startPromise: Promise<{ url: string }> | undefined;

export function newBridgeToken(): string {
	return randomBytes(32).toString("hex");
}

export function registerBridgeSession(token: string, handlers: BridgeSessionHandlers): void {
	unregisterBridgeSession(token);
	sessions.set(token, { handlers, controllers: new Set() });
}

export function unregisterBridgeSession(token: string): void {
	const session = sessions.get(token);
	if (session === undefined) return;
	sessions.delete(token);
	for (const controller of session.controllers) controller.abort();
	session.controllers.clear();
}

export async function startBridgeServer(): Promise<{ url: string }> {
	if (server !== undefined && serverUrl !== undefined) return { url: serverUrl };
	if (startPromise !== undefined) return startPromise;

	const pending = startServer();
	startPromise = pending;
	try {
		return await pending;
	} finally {
		if (startPromise === pending) startPromise = undefined;
	}
}

export async function stopBridgeServer(): Promise<void> {
	if (startPromise !== undefined) await startPromise;
	const current = server;
	server = undefined;
	serverUrl = undefined;

	for (const token of [...sessions.keys()]) unregisterBridgeSession(token);
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	if (current === undefined) return;

	await new Promise<void>((resolve, reject) => {
		current.close((error) => {
			if (error !== undefined) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function startServer(): Promise<{ url: string }> {
	const candidate = createServer((request, response) => {
		void handleRequest(request, response).catch((error: unknown) => {
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (!response.headersSent && !response.destroyed) {
				writeJson(response, 500, jsonRpcError(null, -32603, normalized.message));
				return;
			}
			response.destroy(normalized);
		});
	});
	candidate.requestTimeout = 0;
	candidate.headersTimeout = LARGE_HEADERS_TIMEOUT_MS;
	candidate.timeout = 0;
	candidate.keepAliveTimeout = 0;
	candidate.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve, reject) => {
		candidate.once("error", reject);
		candidate.listen(0, HOST, () => {
			candidate.off("error", reject);
			resolve();
		});
	});
	const address = candidate.address();
	if (address === null || typeof address === "string") {
		await new Promise<void>((resolve) => candidate.close(() => resolve()));
		throw new Error("Antigravity bridge server did not bind to a TCP address.");
	}

	candidate.unref();
	server = candidate;
	serverUrl = `http://${HOST}:${address.port}${PATH}`;
	return { url: serverUrl };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = new URL(request.url ?? "/", `http://${HOST}`);
	if (url.pathname !== PATH) {
		writeJson(response, 404, jsonRpcError(null, -32601, "Not found"));
		return;
	}

	const authorized = authorizedSession(request.headers.authorization);
	if (authorized === undefined) {
		writeJson(response, 401, jsonRpcError(null, -32001, "Unauthorized"));
		return;
	}

	if (request.method === "GET") {
		writeJson(response, 405, jsonRpcError(null, -32600, "Method not allowed"));
		return;
	}
	if (request.method === "DELETE") {
		response.writeHead(204).end();
		return;
	}
	if (request.method !== "POST") {
		writeJson(response, 405, jsonRpcError(null, -32600, "Method not allowed"));
		return;
	}

	const body = await readBody(request);
	if (body.kind === "aborted") return;
	if (body.kind === "too-large") {
		writeJson(response, 413, jsonRpcError(null, -32600, "Request body too large"));
		return;
	}
	if (sessions.get(authorized.token) !== authorized.session) {
		writeJson(response, 401, jsonRpcError(null, -32001, "Unauthorized"));
		return;
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body.body);
	} catch (error: unknown) {
		if (!(error instanceof SyntaxError)) throw error;
		writeJson(response, 400, jsonRpcError(null, -32700, "Parse error"));
		return;
	}
	if (!isRecord(payload) || typeof payload.method !== "string") {
		writeJson(response, 400, jsonRpcError(null, -32600, "Invalid Request"));
		return;
	}

	if (!Object.hasOwn(payload, "id")) {
		response.writeHead(202).end();
		return;
	}
	const id = payload.id;
	const params = isRecord(payload.params) ? payload.params : {};

	if (payload.method === "server/discover" || payload.method === "ping") {
		writeResult(response, id, {});
		return;
	}
	if (payload.method === "initialize") {
		writeResult(response, id, {
			protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: BRIDGE_SERVER_NAME, version: "1" },
		});
		return;
	}
	if (payload.method === "tools/list") {
		writeResult(response, id, { tools: authorized.session.handlers.listTools() });
		return;
	}
	if (payload.method === "tools/call") {
		if (typeof params.name !== "string") {
			writeJson(response, 400, jsonRpcError(id, -32602, "Invalid params"));
			return;
		}
		await handleToolCall(
			request,
			response,
			id,
			authorized.session,
			params.name,
			isRecord(params.arguments) ? params.arguments : {},
		);
		return;
	}

	writeJson(response, 200, jsonRpcError(id, -32601, "Method not found"));
}

async function handleToolCall(
	request: IncomingMessage,
	response: ServerResponse,
	id: unknown,
	session: BridgeSession,
	name: string,
	args: Record<string, unknown>,
): Promise<void> {
	const controller = new AbortController();
	session.controllers.add(controller);
	let disconnected = false;
	const onDisconnect = (): void => {
		if (response.writableEnded) return;
		disconnected = true;
		controller.abort();
	};
	request.once("aborted", onDisconnect);
	response.once("close", onDisconnect);

	let result: BridgeCallResult;
	try {
		result = await session.handlers.callTool(name, args, controller.signal);
	} catch (error: unknown) {
		result = {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			isError: true,
		};
	} finally {
		session.controllers.delete(controller);
		request.off("aborted", onDisconnect);
		response.off("close", onDisconnect);
	}

	if (disconnected || response.destroyed || response.writableEnded) return;
	writeResult(response, id, result);
}

function authorizedSession(authorization: string | undefined): AuthorizedSession | undefined {
	if (authorization === undefined) return undefined;
	for (const [token, session] of sessions) {
		if (secureEqual(authorization, `Bearer ${token}`)) return { token, session };
	}
	return undefined;
}

function secureEqual(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readBody(request: IncomingMessage): Promise<BodyResult> {
	const contentLength = Number(request.headers["content-length"]);
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		request.resume();
		return Promise.resolve({ kind: "too-large" });
	}

	request.setEncoding("utf8");
	return new Promise((resolve) => {
		let body = "";
		let bytes = 0;
		let settled = false;
		const finish = (result: BodyResult): void => {
			if (settled) return;
			settled = true;
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("aborted", onAborted);
			request.off("error", onAborted);
			resolve(result);
		};
		const onData = (chunk: string): void => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > MAX_BODY_BYTES) {
				request.resume();
				finish({ kind: "too-large" });
				return;
			}
			body += chunk;
		};
		const onEnd = (): void => finish({ kind: "ok", body });
		const onAborted = (): void => finish({ kind: "aborted" });
		request.on("data", onData);
		request.once("end", onEnd);
		request.once("aborted", onAborted);
		request.once("error", onAborted);
	});
}

function writeResult(response: ServerResponse, id: unknown, result: unknown): void {
	writeJson(response, 200, { jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
	response.writeHead(statusCode, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
