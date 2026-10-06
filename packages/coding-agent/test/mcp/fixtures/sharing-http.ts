import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	PingRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/** Real, stateful HTTP/SSE MCP fixture. All changes are explicitly triggered. */
export async function sharingHttpFixture(port = 0) {
	const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
	let connects = 0;
	let toolName = "echo";
	let toolSchema: Tool["inputSchema"] = { type: "object" };
	let pings = 0;
	let entered = 0;
	let release: (() => void) | undefined;
	let barrier: Promise<void> | undefined;
	const callObservers = new Set<() => void>();
	const pingObservers = new Set<() => void>();
	let listBarrier: Promise<void> | undefined;
	let listEntered: (() => void) | undefined;
	let releaseList: (() => void) | undefined;
	const sockets = new Set<Socket>();
	const eventSockets = new Set<Socket>();
	const http = createServer(async (req, res) => {
		try {
			if (req.method === "GET") eventSockets.add(req.socket);
			const id = req.headers["mcp-session-id"];
			let session = typeof id === "string" ? sessions.get(id) : undefined;
			let body: unknown;
			if (req.method === "POST") {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(Buffer.from(chunk));
				body = JSON.parse(Buffer.concat(chunks).toString());
			}
			if (!session && req.method === "POST" && !id) {
				const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
				const server = new Server(
					{ name: "sharing-fixture", version: "1.0.0" },
					{ capabilities: { tools: { listChanged: true }, resources: { subscribe: true }, logging: {} } },
				);
				server.setRequestHandler(ListToolsRequestSchema, async () => {
					listEntered?.();
					await listBarrier;
					return { tools: [{ name: toolName, inputSchema: toolSchema }] };
				});
				server.setRequestHandler(PingRequestSchema, async () => {
					pings++;
					for (const observer of pingObservers) observer();
					return {};
				});
				server.setRequestHandler(CallToolRequestSchema, async (request) => {
					entered++;
					for (const observer of callObservers) observer();
					await barrier;
					const result =
						request.params.name === "elicit"
							? await server.elicitInput({
									message: "Owner",
									requestedSchema: { type: "object", properties: { value: { type: "string" } } },
								})
							: request.params.arguments;
					return { content: [{ type: "text", text: JSON.stringify(result) }] };
				});
				await server.connect(transport);
				session = { server, transport };
				connects++;
			}
			if (!session) {
				res.writeHead(404).end();
				return;
			}
			await session.transport.handleRequest(req, res, body);
			if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
		} catch (error) {
			if (!res.headersSent) res.writeHead(500).end(String(error));
		}
	});
	http.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
			eventSockets.delete(socket);
		});
	});
	await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
	const address = http.address();
	if (!address || typeof address === "string") throw new Error("fixture has no address");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		get connects() {
			return connects;
		},
		get pings() {
			return pings;
		},
		get calls() {
			return entered;
		},
		setTools(name: string) {
			toolName = name;
		},
		nextPing() {
			return new Promise<void>((resolve) => {
				const done = () => {
					pingObservers.delete(done);
					resolve();
				};
				pingObservers.add(done);
			});
		},
		async elicit() {
			const first = sessions.values().next().value;
			if (!first) throw new Error("fixture has no session");
			return first.server.elicitInput({
				message: "Unowned",
				requestedSchema: { type: "object", properties: { value: { type: "string" } } },
			});
		},
		holdCalls(count: number) {
			barrier = new Promise<void>((resolve) => {
				release = resolve;
			});
			const target = entered + count;
			return new Promise<void>((resolve) => {
				const observe = () => {
					if (entered < target) return;
					callObservers.delete(observe);
					resolve();
				};
				callObservers.add(observe);
			});
		},
		releaseCalls() {
			release?.();
			barrier = undefined;
		},
		async log(message: string) {
			const first = sessions.values().next().value;
			if (!first) throw new Error("fixture has no session");
			await first.server.sendLoggingMessage({ level: "info", data: message });
		},
		dropTransports() {
			http.closeAllConnections();
		},
		async endStreams() {
			for (const { server } of sessions.values()) await server.close();
			sessions.clear();
		},
		async resourceUpdated() {
			const first = sessions.values().next().value;
			if (!first) throw new Error("fixture has no session");
			await first.server.notification({
				method: "notifications/resources/updated",
				params: { uri: "test://changed" },
			});
		},
		async quiesce() {
			const closed = [...sockets]
				.filter((socket) => !eventSockets.has(socket))
				.map((socket) => once(socket, "close", { signal: AbortSignal.timeout(5000) }));
			http.closeIdleConnections();
			await Promise.all(closed);
		},
		holdLists() {
			listBarrier = new Promise<void>((resolve) => {
				releaseList = resolve;
			});
			return new Promise<void>((resolve) => {
				listEntered = resolve;
			});
		},
		releaseLists() {
			releaseList?.();
			listBarrier = undefined;
		},
		async changeTools(name: string, schema: Tool["inputSchema"] = { type: "object" }) {
			toolName = name;
			toolSchema = schema;
			// One notification from the first physical connection, not one per owner.
			const first = sessions.values().next().value;
			if (!first) throw new Error("fixture has no session");
			await first.server.sendToolListChanged();
		},
		async close() {
			releaseList?.();
			release?.();
			for (const { server } of sessions.values()) await server.close();
			await new Promise<void>((resolve, reject) => {
				http.close((error) => (error ? reject(error) : resolve()));
				http.closeAllConnections();
			});
		},
	};
}
