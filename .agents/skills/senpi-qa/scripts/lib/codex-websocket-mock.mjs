/**
 * Fake ChatGPT Codex Responses backend over WebSocket (plus an SSE fallback
 * route) and a TCP blackhole proxy in front of it. The proxy exists because a
 * half-open connection cannot be produced by closing anything: switching it to
 * `blackhole` keeps every socket open and drops bytes in both directions, which
 * is what a dropped network path looks like to the client.
 */

import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { WebSocketServer } from "ws";

export const CODEX_WS_OK_MARKER = "SENPI-QA-CODEX-WS-OK";

function responseEvents(marker, requestIndex) {
	const responseId = `resp_qa_${requestIndex}`;
	return [
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `msg_${requestIndex}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: marker },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: `msg_${requestIndex}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: marker }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				output: [],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		},
	];
}

/**
 * `behavior(requestIndex)` decides each request: `"complete"` streams a full
 * response, `"stall-after-start"` streams only the first two events and then
 * stays silent forever, `"complete-then-close"` completes and closes the
 * socket `closeDelayMs` later (a server idle close on a parked connection).
 */
export function startCodexWebSocketMock({ behavior, closeDelayMs = 500 }) {
	const ledger = [];
	const openSockets = new Set();
	let connections = 0;
	let requestIndex = 0;
	const closeWaiters = new Set();

	const http = createHttpServer((request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/codex/responses")) {
			response.writeHead(404).end();
			return;
		}
		const index = ++requestIndex;
		ledger.push({ index, transport: "sse", mode: "complete" });
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		for (const event of responseEvents(`${CODEX_WS_OK_MARKER}-${index}`, index)) {
			response.write(`data: ${JSON.stringify(event)}\n\n`);
		}
		response.end();
	});

	const wss = new WebSocketServer({ noServer: true });
	http.on("upgrade", (request, socket, head) => {
		if (!request.url?.endsWith("/codex/responses")) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			connections++;
			openSockets.add(ws);
			ws.on("close", () => {
				openSockets.delete(ws);
				for (const waiter of closeWaiters) waiter();
				closeWaiters.clear();
			});
			ws.on("message", (raw) => {
				const parsed = JSON.parse(raw.toString());
				if (parsed.type !== "response.create") return;
				const index = ++requestIndex;
				const mode = behavior(index);
				ledger.push({ index, transport: "websocket", mode, connection: connections });
				const events = responseEvents(`${CODEX_WS_OK_MARKER}-${index}`, index);
				const toSend = mode === "stall-after-start" ? events.slice(0, 2) : events;
				for (const event of toSend) ws.send(JSON.stringify(event));
				if (mode === "complete-then-close") setTimeout(() => ws.close(1001, "server_idle"), closeDelayMs);
			});
		});
	});

	return new Promise((resolve, reject) => {
		http.once("error", reject);
		http.listen(0, "127.0.0.1", () => {
			const address = http.address();
			if (!address || typeof address === "string") {
				reject(new Error("mock codex server has no port"));
				return;
			}
			resolve({
				port: address.port,
				ledger,
				connections: () => connections,
				waitForClose: () => new Promise((done) => closeWaiters.add(done)),
				stop: () =>
					new Promise((done) => {
						for (const ws of openSockets) ws.terminate();
						wss.close();
						http.close(() => done());
					}),
			});
		});
	});
}

/**
 * TCP pass-through proxy that can turn one connection into a half-open one.
 * `blackholeAfterUpstreamChunk(marker)` arms a one-shot trip: the next
 * upstream->client chunk containing `marker` is still delivered, then that
 * connection pair goes dark in both directions - sockets stay open, bytes are
 * dropped - which is what a dropped network path looks like to the client.
 * Connections opened afterwards pass normally, like a recovered network.
 */
export function startBlackholeProxy(targetPort) {
	const state = { tripMarker: undefined, trips: 0 };
	const pairs = new Set();
	const server = createTcpServer((client) => {
		const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
		const pair = { client, upstream, dark: false };
		pairs.add(pair);
		const forward = (from, to, fromUpstream) => {
			from.on("data", (chunk) => {
				if (pair.dark) return;
				to.write(chunk);
				if (fromUpstream && state.tripMarker !== undefined && chunk.toString("latin1").includes(state.tripMarker)) {
					pair.dark = true;
					state.tripMarker = undefined;
					state.trips++;
				}
			});
			from.on("end", () => {
				if (!pair.dark) to.end();
			});
			from.on("error", () => to.destroy());
		};
		forward(client, upstream, false);
		forward(upstream, client, true);
		const forget = () => pairs.delete(pair);
		client.on("close", forget);
		upstream.on("close", forget);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("blackhole proxy has no port"));
				return;
			}
			resolve({
				port: address.port,
				blackholeAfterUpstreamChunk: (marker) => {
					state.tripMarker = marker;
				},
				trips: () => state.trips,
				stop: () =>
					new Promise((done) => {
						for (const { client, upstream } of pairs) {
							client.destroy();
							upstream.destroy();
						}
						server.close(() => done());
					}),
			});
		});
	});
}
