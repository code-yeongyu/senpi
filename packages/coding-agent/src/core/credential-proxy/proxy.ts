/**
 * The loopback credential proxy (senpi#6820). A child calls `http://127.0.0.1:<port>/<capability>/<env name>/<path>`;
 * the proxy forwards to that credential's fixed origin with the header set from the value it holds. Security rules:
 * the upstream host never comes from the request, redirects are returned rather than followed (a followed redirect
 * would carry the header to another host), and no error text the child can read includes the value.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { type CredentialDeclaration, hasUnsafePathSegment } from "./declarations.ts";

export interface ProxiedCredential {
	readonly declaration: CredentialDeclaration;
	readonly value: string;
}

export interface CredentialProxy {
	/** The route a child uses for one credential: `http://127.0.0.1:<port>/<capability>/<env>`. */
	routeFor(env: string): string | undefined;
	close(): Promise<void>;
}

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const DROPPED_REQUEST_HEADERS = new Set([
	"accept-encoding",
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
	"connection",
	"content-encoding",
	"content-length",
	"keep-alive",
	"transfer-encoding",
]);

function refuse(response: ServerResponse, status: number, reason: string): void {
	if (response.headersSent) {
		response.destroy();
		return;
	}
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	response.end(`senpi credential proxy: ${reason}\n`);
}

function sameCapability(given: string, expected: Buffer): boolean {
	const bytes = Buffer.from(given);
	return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
	if (request.method === "GET" || request.method === "HEAD") return undefined;
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_REQUEST_BYTES) throw new RangeError("request body too large");
		chunks.push(buffer);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}
	return body;
}

function forwardedHeaders(request: IncomingMessage, credential: ProxiedCredential): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		const lower = name.toLowerCase();
		if (value === undefined || DROPPED_REQUEST_HEADERS.has(lower) || lower === credential.declaration.header)
			continue;
		for (const item of Array.isArray(value) ? value : [value]) headers.append(lower, item);
	}
	const { scheme, header } = credential.declaration;
	headers.set(header, scheme === undefined ? credential.value : `${scheme} ${credential.value}`);
	headers.set("accept-encoding", "identity");
	return headers;
}

function allowedPath(path: string, credential: ProxiedCredential): boolean {
	if (hasUnsafePathSegment(path)) return false;
	const prefixes = credential.declaration.pathPrefixes;
	return (
		prefixes === undefined ||
		prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
	);
}

async function relay(upstream: Response, response: ServerResponse): Promise<void> {
	const headers: Record<string, string[]> = {};
	upstream.headers.forEach((value, name) => {
		if (DROPPED_RESPONSE_HEADERS.has(name)) return;
		(headers[name] ??= []).push(value);
	});
	response.writeHead(upstream.status, headers);
	if (upstream.body === null) {
		response.end();
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const body = Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>);
		body.on("error", reject);
		response.on("close", () => {
			body.destroy();
			resolve();
		});
		body.pipe(response).on("finish", resolve);
	});
}

function handler(capability: Buffer, byEnv: ReadonlyMap<string, ProxiedCredential>) {
	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const target = request.url ?? "";
		if (!target.startsWith("/")) return refuse(response, 400, "only origin-form requests are accepted");
		const queryAt = target.indexOf("?");
		const path = queryAt === -1 ? target : target.slice(0, queryAt);
		const query = queryAt === -1 ? "" : target.slice(queryAt);
		const [, given = "", env = "", ...rest] = path.split("/");
		const credential = byEnv.get(env);
		if (!sameCapability(given, capability) || credential === undefined) return refuse(response, 403, "unknown route");
		const upstreamPath = `/${rest.join("/")}`;
		if (!allowedPath(upstreamPath, credential)) return refuse(response, 403, "path not allowed for this credential");
		let body: Uint8Array<ArrayBuffer> | undefined;
		try {
			body = await readBody(request);
		} catch {
			return refuse(response, 413, "request body too large");
		}
		let upstream: Response;
		try {
			upstream = await fetch(`${credential.declaration.origin}${upstreamPath === "/" ? "" : upstreamPath}${query}`, {
				method: request.method ?? "GET",
				headers: forwardedHeaders(request, credential),
				redirect: "manual",
				...(body === undefined ? {} : { body }),
			});
		} catch {
			return refuse(response, 502, "upstream request failed");
		}
		try {
			await relay(upstream, response);
		} catch {
			response.destroy();
		}
	};
}

/** Binds the proxy on loopback; rejects when it cannot listen, so the caller never falls back to passing values. */
export async function startCredentialProxy(credentials: readonly ProxiedCredential[]): Promise<CredentialProxy> {
	const capabilityText = randomBytes(32).toString("base64url");
	const capability = Buffer.from(capabilityText);
	const byEnv = new Map(credentials.map((credential) => [credential.declaration.env, credential]));
	const server: Server = createServer((request, response) => {
		void handler(capability, byEnv)(request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.unref();
	const { port } = server.address() as AddressInfo;
	return {
		routeFor: (env) => (byEnv.has(env) ? `http://127.0.0.1:${port}/${capabilityText}/${env}` : undefined),
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
