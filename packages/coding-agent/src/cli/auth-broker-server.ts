import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import type { AuthBrokerService } from "../core/auth-broker.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;

export type AuthBrokerBind = {
	readonly host: "127.0.0.1" | "::1" | "localhost";
	readonly port: number;
};

export type AuthBrokerServerHandle = {
	readonly url: string;
	close: () => Promise<void>;
};

export class AuthBrokerServerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthBrokerServerError";
	}
}

export function parseAuthBrokerBind(value: string): AuthBrokerBind {
	const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(value);
	const ipv4 = /^([^:]+):(\d+)$/.exec(value);
	const match = ipv6 ?? ipv4;
	if (!match)
		throw new AuthBrokerServerError("Invalid broker bind; use 127.0.0.1:PORT, [::1]:PORT, or localhost:PORT");
	const host = match[1];
	const port = Number(match[2]);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AuthBrokerServerError("Invalid broker bind port");
	if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost")
		throw new AuthBrokerServerError("Broker must bind to loopback");
	return { host, port };
}

export async function startAuthBrokerServer(options: {
	readonly bind: AuthBrokerBind;
	readonly broker: AuthBrokerService;
	readonly version: string;
}): Promise<AuthBrokerServerHandle> {
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		void handleRequest(request, response, options);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.bind.port, options.bind.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new AuthBrokerServerError("Broker did not expose a TCP address");
	}
	return {
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
			});
		},
		url: formatUrl(address),
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	options: {
		readonly broker: AuthBrokerService;
		readonly version: string;
	},
): Promise<void> {
	if (request.method === "GET" && request.url === "/healthz") {
		writeJson(response, 200, { ok: true, version: options.version });
		return;
	}
	if (request.method !== "POST" || request.url !== "/v1/broker") {
		writeJson(response, 404, { error: "not_found" });
		return;
	}
	const authentication = bearerToken(request.headers.authorization);
	if (authentication === undefined) {
		writeJson(response, 401, { error: "unauthorized" });
		return;
	}
	if (!options.broker.isAuthorized(authentication)) {
		writeJson(response, 401, { error: "unauthorized" });
		return;
	}
	try {
		const body = await readJson(request);
		const result = await options.broker.handle(body, authentication);
		writeJson(response, 200, result);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid broker request";
		writeJson(response, 400, { error: sanitizeError(message) });
	}
}

function bearerToken(value: string | undefined): string | undefined {
	const match = /^Bearer ([A-Za-z0-9_-]{16,})$/.exec(value ?? "");
	return match?.[1];
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > MAX_REQUEST_BYTES) throw new AuthBrokerServerError("Broker request exceeds size limit");
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new AuthBrokerServerError("Invalid broker request body");
	}
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

function formatUrl(address: AddressInfo): string {
	const host = isIP(address.address) === 6 ? `[${address.address}]` : address.address;
	return `http://${host}:${address.port}`;
}

function sanitizeError(message: string): string {
	if (message.includes("token") || message.includes("secret") || message.includes("key"))
		return "Broker request rejected";
	return message;
}
