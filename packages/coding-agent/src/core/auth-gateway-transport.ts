import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import {
	hostForUrl,
	loadTls,
	parseAllowedOrigins,
	resolveGatewayAuth,
	validateTransportOptions,
} from "./auth-gateway-transport-auth.ts";
import { handleGatewayRequest } from "./auth-gateway-transport-request.ts";
import type { AuthGatewayTransportHandle, AuthGatewayTransportOptions } from "./auth-gateway-transport-types.ts";
import { AuthGatewayTransportConfigError } from "./auth-gateway-transport-types.ts";

export type {
	AuthGatewayMtlsProfile,
	AuthGatewayTls,
	AuthGatewayTransportAuth,
	AuthGatewayTransportHandle,
	AuthGatewayTransportOptions,
	AuthGatewayTransportRequest,
	AuthGatewayTransportResponse,
} from "./auth-gateway-transport-types.ts";
export { AuthGatewayTransportConfigError } from "./auth-gateway-transport-types.ts";

const DEFAULT_BODY_BYTES = 1_048_576;
const DEFAULT_CONCURRENT_REQUESTS = 64;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

type GatewayServer = ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;

export async function startAuthGatewayTransport(
	options: AuthGatewayTransportOptions,
): Promise<AuthGatewayTransportHandle> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const allowedOrigins = parseAllowedOrigins(options.allowedOrigins ?? []);
	validateTransportOptions({ ...options, host, port });
	const auth = await resolveGatewayAuth(options.auth);
	const tls = options.tls === undefined ? undefined : await loadTls(options.tls);
	const activeRequests = new Set<AbortController>();
	const sockets = new Set<Socket>();
	let accepting = true;
	let requestCount = 0;
	const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_CONCURRENT_REQUESTS;
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_BYTES;
	const handler = (request: IncomingMessage, response: ServerResponse): void => {
		void handleGatewayRequest({
			accepting,
			activeRequests,
			allowedOrigins,
			auth,
			idleTimeoutMs,
			maxBodyBytes,
			maxConcurrentRequests,
			onRequest: options.onRequest,
			request,
			requestCount: () => requestCount,
			response,
			trustedProxy: options.trustedProxy,
			version: options.version ?? "unknown",
		}).finally(() => {
			requestCount -= 1;
		});
		requestCount += 1;
	};
	const server = tls === undefined ? createHttpServer(handler) : createHttpsServer(tls, handler);
	server.headersTimeout = idleTimeoutMs;
	server.requestTimeout = idleTimeoutMs;
	server.keepAliveTimeout = idleTimeoutMs;
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await listen(server, host, port);
	const address = server.address();
	if (address === null || typeof address === "string") {
		await closeGatewayServer(server);
		throw new AuthGatewayTransportConfigError("Auth gateway did not bind to a TCP address.");
	}
	const protocol = tls === undefined ? "http" : "https";
	return {
		host,
		port: address.port,
		tokenFile: auth.path,
		url: `${protocol}://${hostForUrl(host)}:${address.port}`,
		async close() {
			accepting = false;
			for (const controller of activeRequests) controller.abort();
			for (const socket of sockets) socket.destroy();
			await closeGatewayServer(server);
		},
	};
}

function listen(server: GatewayServer, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeGatewayServer(server: GatewayServer): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error: Error | undefined) => {
			if (error === undefined) {
				resolve();
				return;
			}
			reject(error);
		});
	});
}
