import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { RpcEnvelope } from "../rpc/envelope.ts";
import { parseNdjsonLine, serializeNdjsonMessage } from "../rpc/ndjson.ts";
import type { TransportKind } from "../server/connection.ts";
import type { ServerCore } from "../server/server-core.ts";
import { isWebSocketRequestAuthorized, type ResolvedWebSocketListenerAuth } from "./websocket-auth.ts";

const DEFAULT_OUTBOUND_QUEUE_BYTES = 16 * 1024 * 1024;
const WEBSOCKET_RETRY_LATER = 1013;

export type AppServerWebSocketConnectionHandler = {
	readonly connectionCount: number;
	handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
	terminateConnections(): void;
	close(): Promise<void>;
};

export function createAppServerWebSocketConnectionHandler(options: {
	readonly core: ServerCore;
	readonly auth: ResolvedWebSocketListenerAuth;
	readonly transportKind: TransportKind;
	readonly connectionIdPrefix: string;
	readonly outboundQueueBytes?: number;
}): AppServerWebSocketConnectionHandler {
	const webSocketServer = new WebSocketServer({ noServer: true });
	const connections = new Set<WebSocket>();
	let nextConnectionId = 1;
	const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
		if (hasOrigin(request)) {
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}
		if (request.url !== "/") {
			rejectUpgrade(socket, 400, "Bad Request");
			return;
		}
		if (!isWebSocketRequestAuthorized(request, options.auth)) {
			rejectUpgrade(socket, 401, "Unauthorized");
			return;
		}
		webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
			const connectionId = `${options.connectionIdPrefix}-${nextConnectionId}`;
			nextConnectionId += 1;
			connections.add(websocket);
			options.core.addConnection({
				id: connectionId,
				transportKind: options.transportKind,
				send: (message) => sendWebSocketMessage(websocket, message, options.outboundQueueBytes),
				close: () => websocket.close(WEBSOCKET_RETRY_LATER, "slow-client"),
			});
			websocket.on("message", (data, isBinary) => {
				if (isBinary) return;
				const parsed = parseNdjsonLine(data.toString("utf8"));
				if (parsed.kind === "parse-error") {
					sendWebSocketMessage(websocket, parsed.message, options.outboundQueueBytes).catch((error: unknown) => {
						terminateOnTransportError(websocket, error);
					});
					return;
				}
				// A rejected dispatch (e.g. the response send failing on a dying socket)
				// must not surface as an unhandled rejection that kills the server.
				options.core.receive(connectionId, parsed).catch((error: unknown) => {
					terminateOnTransportError(websocket, error);
				});
			});
			websocket.on("error", (error: unknown) => {
				// A socket-level error with no listener throws and can crash the
				// server; isolate the fault to this connection instead.
				const message = error instanceof Error ? error.message : String(error);
				process.stderr.write(`app-server websocket connection error: ${message}\n`);
				websocket.terminate();
			});
			websocket.on("close", () => {
				connections.delete(websocket);
				options.core.removeConnection(connectionId);
			});
		});
	};
	return {
		get connectionCount() {
			return connections.size;
		},
		handleUpgrade,
		terminateConnections() {
			for (const websocket of connections) websocket.terminate();
		},
		close() {
			return closeServer(webSocketServer);
		},
	};
}

export function closeServer(server: Pick<Server | WebSocketServer, "close">): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) return reject(error);
			resolve();
		});
	});
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
			if (error) return reject(error);
			resolve();
		});
	});
}

function terminateOnTransportError(websocket: WebSocket, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`app-server websocket transport error: ${message}\n`);
	websocket.terminate();
}

function waitForSocketClose(websocket: WebSocket): Promise<void> {
	if (websocket.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise((resolve) => {
		websocket.once("close", () => resolve());
	});
}

function hasOrigin(request: IncomingMessage): boolean {
	return request.headers.origin !== undefined;
}

function rejectUpgrade(socket: Duplex, statusCode: 400 | 401 | 403, reason: string): void {
	socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}
