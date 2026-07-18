import { timingSafeEqual } from "node:crypto";

function safeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	if (a.length !== b.length) {
		const padded = Buffer.alloc(b.length);
		a.copy(padded, 0, 0, Math.min(a.length, padded.length));
		timingSafeEqual(padded, b);
		return false;
	}
	return timingSafeEqual(a, b);
}
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedGatewayAuth } from "./auth-gateway-transport-auth.ts";
import { writeGatewayResponse, writeJson } from "./auth-gateway-transport-response.ts";
import type { AuthGatewayTransportOptions } from "./auth-gateway-transport-types.ts";

const GATEWAY_ROUTES = new Map<string, readonly string[]>([
	["/v1/models", ["GET"]],
	["/v1/usage", ["GET"]],
	["/v1/credentials/check", ["GET"]],
	["/v1/chat/completions", ["POST"]],
	["/v1/messages", ["POST"]],
	["/v1/responses", ["POST"]],
	["/v1/pi/stream", ["POST"]],
]);

export async function handleGatewayRequest(options: {
	readonly accepting: boolean;
	readonly activeRequests: Set<AbortController>;
	readonly allowedOrigins: ReadonlySet<string>;
	readonly auth: ResolvedGatewayAuth;
	readonly idleTimeoutMs: number;
	readonly maxBodyBytes: number;
	readonly maxConcurrentRequests: number;
	readonly onRequest: AuthGatewayTransportOptions["onRequest"];
	readonly request: IncomingMessage;
	readonly requestCount: () => number;
	readonly response: ServerResponse;
	readonly trustedProxy: string | undefined;
	readonly version: string;
}): Promise<void> {
	const { request, response } = options;
	if (!options.accepting) {
		writeJson(response, 503, { error: "gateway shutting down" });
		return;
	}
	if (options.requestCount() >= options.maxConcurrentRequests) {
		writeJson(response, 503, { error: "gateway overloaded" });
		return;
	}
	const origin = request.headers.origin;
	if (origin !== undefined && !options.allowedOrigins.has(origin)) {
		writeJson(response, 403, { error: "origin forbidden" });
		return;
	}
	const corsHeaders = origin === undefined ? undefined : corsHeadersFor(origin);
	if (request.method === "GET" && request.url === "/healthz") {
		writeJson(response, 200, { ok: true, version: options.version }, corsHeaders);
		return;
	}
	const pathname = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
	const allowedMethods = GATEWAY_ROUTES.get(pathname);
	// CORS preflight has no Authorization header; answer before bearer checks.
	if (request.method === "OPTIONS") {
		if (origin === undefined || allowedMethods === undefined || !preflightIsAllowed(request, allowedMethods)) {
			writeJson(response, 404, { error: "route not found" }, corsHeaders);
			return;
		}
		response.writeHead(204, {
			...(corsHeaders ?? {}),
			"access-control-allow-methods": allowedMethods.join(", "),
			"access-control-allow-headers":
				"authorization, content-type, x-senpi-credential-selector, x-senpi-session-id",
			"access-control-max-age": "600",
		}).end();
		return;
	}
	if (!isAuthorized(request, options.auth.token)) {
		writeJson(response, 401, { error: "unauthorized" }, corsHeaders);
		return;
	}
	if (allowedMethods === undefined || request.method === undefined || !allowedMethods.includes(request.method)) {
		writeJson(response, 404, { error: "route not found" }, corsHeaders);
		return;
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	request.once("aborted", abort);
	response.once("close", () => {
		if (!response.writableEnded) controller.abort();
	});
	options.activeRequests.add(controller);
	try {
		const body =
			request.method === "POST"
				? await readJsonBody(request, options.maxBodyBytes, options.idleTimeoutMs)
				: undefined;
		if (controller.signal.aborted) return;
		const result =
			options.onRequest === undefined
				? { body: { error: "route adapter unavailable" }, statusCode: 501 }
				: await options.onRequest({
						body,
						method: request.method,
						pathname,
						peerAddress: resolvePeerAddress(request, options.trustedProxy),
						signal: controller.signal,
					});
		if (!controller.signal.aborted) {
			await writeGatewayResponse(response, result, controller.signal, { ...corsHeaders, ...result.headers });
		}
	} catch (error: unknown) {
		if (controller.signal.aborted) return;
		if (error instanceof GatewayRequestError) {
			writeJson(response, error.statusCode, { error: error.message }, corsHeaders);
			return;
		}
		writeJson(response, 500, { error: "gateway request failed" }, corsHeaders);
	} finally {
		request.off("aborted", abort);
		options.activeRequests.delete(controller);
	}
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
	if (token.length < 32) return false;
	const header = request.headers.authorization;
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
	const provided = header.slice("Bearer ".length).trim();
	if (provided.length < 32) return false;
	return safeEqual(provided, token);
}

function corsHeadersFor(origin: string): Readonly<Record<string, string>> {
	return {
		"access-control-allow-headers": "authorization, content-type",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-origin": origin,
		"access-control-max-age": "600",
		vary: "Origin",
	};
}

function preflightIsAllowed(request: IncomingMessage, allowedMethods: readonly string[]): boolean {
	const requestedMethod = request.headers["access-control-request-method"];
	return typeof requestedMethod === "string" && allowedMethods.includes(requestedMethod);
}

function resolvePeerAddress(request: IncomingMessage, trustedProxy: string | undefined): string | undefined {
	const peer = request.socket.remoteAddress;
	if (trustedProxy === undefined || peer !== trustedProxy) return peer;
	const forwarded = request.headers["x-forwarded-for"];
	if (typeof forwarded !== "string") return peer;
	const candidate = forwarded.split(",")[0]?.trim();
	return candidate === "" || candidate === undefined ? peer : candidate;
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number, idleTimeoutMs: number): Promise<unknown> {
	const contentType = request.headers["content-type"];
	const mediaType = typeof contentType === "string" ? contentType.split(";", 1)[0]?.trim().toLowerCase() : undefined;
	if (mediaType !== "application/json") {
		throw new GatewayRequestError(415, "content type must be application/json");
	}
	const contentLength = request.headers["content-length"];
	if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBodyBytes)) {
		throw new GatewayRequestError(413, "request body too large");
	}
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	return await new Promise<unknown>((resolve, reject) => {
		let timer = setTimeout(() => fail(new GatewayRequestError(408, "request body timed out")), idleTimeoutMs);
		const reset = () => {
			clearTimeout(timer);
			timer = setTimeout(() => fail(new GatewayRequestError(408, "request body timed out")), idleTimeoutMs);
		};
		const cleanup = () => {
			clearTimeout(timer);
			request.off("aborted", aborted);
			request.off("data", data);
			request.off("end", end);
			request.off("error", failed);
		};
		const fail = (error: Error) => {
			cleanup();
			reject(error);
		};
		const aborted = () => fail(new GatewayRequestError(499, "request aborted"));
		const data = (chunk: Buffer) => {
			reset();
			totalBytes += chunk.length;
			if (totalBytes > maxBodyBytes) {
				fail(new GatewayRequestError(413, "request body too large"));
				request.resume();
				return;
			}
			chunks.push(chunk);
		};
		const end = () => {
			cleanup();
			const text = Buffer.concat(chunks).toString("utf8");
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new GatewayRequestError(400, "malformed JSON body"));
			}
		};
		const failed = () => fail(new GatewayRequestError(400, "request body failed"));
		request.on("aborted", aborted);
		request.on("data", data);
		request.once("end", end);
		request.once("error", failed);
	});
}

class GatewayRequestError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "GatewayRequestError";
		this.statusCode = statusCode;
	}
}
