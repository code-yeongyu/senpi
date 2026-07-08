import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { type BridgeError, generateBridgeToken, verifyBridgeToken } from "./protocol.ts";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const LOOPBACK_HOST = "127.0.0.1";

export interface BridgeHttpCallRequest {
	callId: string;
	toolName: string;
	args: unknown;
	signal: AbortSignal;
}

export interface BridgeHttpCompletionRequest {
	prompt: string;
	opts?: unknown;
	signal: AbortSignal;
}

export type BridgeHttpEmitEvent =
	| { kind: "text"; stream: "stdout" | "stderr"; data: string }
	| { kind: "display"; mimeType: string; dataBase64: string }
	| { kind: "log"; message: string }
	| { kind: "phase"; title: string };

export interface BridgeServerOptions {
	token?: string;
	bodyLimitBytes?: number;
	onCall: (request: BridgeHttpCallRequest) => Promise<unknown>;
	onEmit: (event: BridgeHttpEmitEvent, signal: AbortSignal) => Promise<void>;
	onCompletion: (request: BridgeHttpCompletionRequest) => Promise<unknown>;
}

export interface BridgeServerHandle {
	port: number;
	token: string;
	close: () => Promise<void>;
}

type JsonReply = { ok: true; value: unknown } | { ok: false; error: BridgeError };
type Route = "/call" | "/emit" | "/completion";

export async function startBridgeServer(options: BridgeServerOptions): Promise<BridgeServerHandle> {
	const token = options.token ?? generateBridgeToken();
	const sockets = new Set<Socket>();
	let closing: Promise<void> | undefined;
	const server = createServer((request, response) => {
		void handleRequest(request, response, token, options);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.listen(0, LOOPBACK_HOST);
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Bridge server did not bind to a TCP port");

	return {
		port: (address as AddressInfo).port,
		token,
		close: async () => {
			closing ??= closeServer(server, sockets);
			await closing;
		},
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	token: string,
	options: BridgeServerOptions,
): Promise<void> {
	const abortController = new AbortController();
	request.on("close", () => abortController.abort());
	if (request.method !== "POST") {
		sendJson(response, 404, { ok: false, error: transportError("not_found", "Bridge route was not found") });
		return;
	}
	const route = routeFromUrl(request.url ?? "");
	if (!route) {
		sendJson(response, 404, { ok: false, error: transportError("not_found", "Bridge route was not found") });
		return;
	}
	const auth = parseBearerToken(request.headers.authorization);
	if (!auth || !verifyBridgeToken(token, auth).ok) {
		sendJson(response, 401, { ok: false, error: transportError("unauthorized", "Bridge authorization failed") });
		return;
	}

	const parsed = await readJsonBody(request, options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES);
	if (!parsed.ok) {
		sendJson(response, parsed.status, { ok: false, error: transportError(parsed.code, parsed.message) });
		return;
	}

	if (route === "/emit") {
		const event = parseEmitEvent(parsed.value);
		if (!event.ok) {
			sendJson(response, 400, { ok: false, error: transportError("invalid_request", event.message) });
			return;
		}
		try {
			await options.onEmit(event.event, abortController.signal);
			response.writeHead(204).end();
		} catch (error) {
			sendJson(response, 200, { ok: false, error: bridgeError(error) });
		}
		return;
	}

	const reply =
		route === "/call"
			? await dispatchCall(parsed.value, options, abortController.signal)
			: await dispatchCompletion(parsed.value, options, abortController.signal);
	sendJson(response, 200, reply);
}

async function dispatchCall(body: unknown, options: BridgeServerOptions, signal: AbortSignal): Promise<JsonReply> {
	if (!isRecord(body) || typeof body.callId !== "string" || typeof body.toolName !== "string" || !("args" in body)) {
		return { ok: false, error: transportError("invalid_request", "Bridge call request was invalid") };
	}
	try {
		return {
			ok: true,
			value: await options.onCall({ callId: body.callId, toolName: body.toolName, args: body.args, signal }),
		};
	} catch (error) {
		return { ok: false, error: bridgeError(error) };
	}
}

async function dispatchCompletion(
	body: unknown,
	options: BridgeServerOptions,
	signal: AbortSignal,
): Promise<JsonReply> {
	if (!isRecord(body) || typeof body.prompt !== "string") {
		return { ok: false, error: transportError("invalid_request", "Bridge completion request was invalid") };
	}
	try {
		return { ok: true, value: await options.onCompletion({ prompt: body.prompt, opts: body.opts, signal }) };
	} catch (error) {
		return { ok: false, error: bridgeError(error) };
	}
}

async function readJsonBody(
	request: IncomingMessage,
	limit: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; code: string; message: string }> {
	let raw = "";
	for await (const chunk of request) {
		raw += String(chunk);
		if (Buffer.byteLength(raw, "utf8") > limit) {
			return {
				ok: false,
				status: 413,
				code: "body_too_large",
				message: `Bridge request body exceeds ${limit} bytes`,
			};
		}
	}
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch {
		return { ok: false, status: 400, code: "invalid_json", message: "Bridge request body was not valid JSON" };
	}
}

function parseEmitEvent(value: unknown): { ok: true; event: BridgeHttpEmitEvent } | { ok: false; message: string } {
	if (!isRecord(value) || typeof value.kind !== "string")
		return { ok: false, message: "Bridge emit request was invalid" };
	if (
		value.kind === "text" &&
		(value.stream === "stdout" || value.stream === "stderr") &&
		typeof value.data === "string"
	) {
		return { ok: true, event: { kind: value.kind, stream: value.stream, data: value.data } };
	}
	if (value.kind === "display" && typeof value.mimeType === "string" && typeof value.dataBase64 === "string") {
		return { ok: true, event: { kind: value.kind, mimeType: value.mimeType, dataBase64: value.dataBase64 } };
	}
	if (value.kind === "log" && typeof value.message === "string") {
		return { ok: true, event: { kind: value.kind, message: value.message } };
	}
	if (value.kind === "phase" && typeof value.title === "string") {
		return { ok: true, event: { kind: value.kind, title: value.title } };
	}
	return { ok: false, message: "Bridge emit request was invalid" };
}

function routeFromUrl(rawUrl: string): Route | undefined {
	const path = new URL(rawUrl, "http://127.0.0.1").pathname;
	if (path === "/call" || path === "/emit" || path === "/completion") return path;
	return undefined;
}

function parseBearerToken(header: string | undefined): string | undefined {
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) return undefined;
	return header.slice(prefix.length);
}

function sendJson(response: ServerResponse, status: number, body: JsonReply): void {
	if (response.destroyed) return;
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

function bridgeError(error: unknown): BridgeError {
	if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
	return { message: String(error) };
}

function transportError(code: string, message: string): BridgeError {
	return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function closeServer(server: ReturnType<typeof createServer>, sockets: Set<Socket>): Promise<void> {
	server.closeAllConnections?.();
	for (const socket of sockets) socket.destroy();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error && "code" in error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
			else resolve();
		});
	});
}
