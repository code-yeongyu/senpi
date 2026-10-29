import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A real streamable-HTTP MCP server whose `initialize` and `tools/list` replies wait until the test releases them,
// so a test chooses how parallel connects interleave instead of racing them.

export const BOUND_MS = 10_000;

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), BOUND_MS);
	});
	try {
		return await Promise.race([promise, expired]);
	} finally {
		clearTimeout(timer);
	}
}

export interface GatedServer {
	readonly url: string;
	readonly initializeArrived: Promise<void>;
	readonly toolsListArrived: Promise<void>;
	releaseInitialize(): void;
	releaseToolsList(): void;
	close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function gatedServer(name: string): Promise<GatedServer> {
	const initializeArrived = deferred();
	const initializeGate = deferred();
	const toolsListArrived = deferred();
	const toolsListGate = deferred();
	const transports = new Map<string, StreamableHTTPServerTransport>();
	const servers: Server[] = [];
	const sockets = new Set<Socket>();
	const http = createServer(async (req, res) => {
		try {
			const body = req.method === "POST" ? await readBody(req) : undefined;
			const method = typeof body === "object" && body !== null && "method" in body ? String(body.method) : undefined;
			if (method === "initialize") {
				initializeArrived.resolve();
				await initializeGate.promise;
			}
			if (method === "tools/list") {
				toolsListArrived.resolve();
				await toolsListGate.promise;
			}
			const sessionId = req.headers["mcp-session-id"];
			let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
			if (transport === undefined) {
				if (method !== "initialize") {
					res.writeHead(404).end();
					return;
				}
				const created = new StreamableHTTPServerTransport({
					sessionIdGenerator: randomUUID,
					onsessioninitialized: (id) => {
						transports.set(id, created);
					},
				});
				const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
				server.setRequestHandler(ListToolsRequestSchema, async () => ({
					tools: [{ name: `${name}_tool`, inputSchema: { type: "object" as const } }],
				}));
				servers.push(server);
				await server.connect(created);
				transport = created;
			}
			await transport.handleRequest(req, res, body);
		} catch (error) {
			if (!res.headersSent) res.writeHead(500).end(error instanceof Error ? error.message : String(error));
		}
	});
	http.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	http.listen(0, "127.0.0.1");
	await once(http, "listening");
	const address = http.address();
	if (address === null || typeof address === "string") throw new Error("gated MCP server did not bind TCP");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		initializeArrived: initializeArrived.promise,
		toolsListArrived: toolsListArrived.promise,
		releaseInitialize: initializeGate.resolve,
		releaseToolsList: toolsListGate.resolve,
		async close() {
			initializeGate.resolve();
			toolsListGate.resolve();
			for (const server of servers) await server.close().catch(() => undefined);
			for (const socket of sockets) socket.destroy();
			http.close();
		},
	};
}
