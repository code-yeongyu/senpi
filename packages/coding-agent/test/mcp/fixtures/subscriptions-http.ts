import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeServer } from "../../../src/core/extensions/builtin/mcp/config.ts";
import { ServerConnection } from "../../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../../src/core/extensions/builtin/mcp/log.ts";

export interface WireRequest {
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

/** Synthetic peer only: all client behavior runs through ServerConnection and its real SDK adapter. */
export async function openFixture(
	options: {
		tools?: unknown[];
		toolResult?: Record<string, unknown>;
		capabilities?: Record<string, unknown>;
	} = {},
) {
	const requests: Array<{ message: WireRequest; headers: IncomingHttpHeaders }> = [];
	const streams: Array<{ message: WireRequest; response: ServerResponse }> = [];
	const listeners = new Map<string, Array<(message: WireRequest) => void>>();
	const next = (method: string) =>
		new Promise<WireRequest>((resolve) => {
			const pending = listeners.get(method) ?? [];
			pending.push(resolve);
			listeners.set(method, pending);
		});
	const root = await mkdtemp(join(tmpdir(), "triage-http-"));
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString()) as WireRequest;
		requests.push({ message, headers: request.headers });
		for (const resolve of listeners.get(message.method) ?? []) resolve(message);
		listeners.delete(message.method);
		if (message.method === "subscriptions/listen") {
			streams.push({ message, response });
			const meta = { "io.modelcontextprotocol/subscriptionId": message.id };
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(
				`data: ${JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/subscriptions/acknowledged",
					params: { _meta: meta, notifications: message.params?.notifications },
				})}\n\n`,
			);
			return;
		}
		const result = (() => {
			switch (message.method) {
				case "server/discover":
					return {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: options.capabilities ?? {
							tools: { listChanged: true },
							prompts: { listChanged: true },
							resources: { listChanged: true, subscribe: true },
						},
						_meta: { "io.modelcontextprotocol/serverInfo": { name: "synthetic-peer", version: "1" } },
					};
				case "tools/list":
					return {
						resultType: "complete",
						tools: options.tools ?? [{ name: "echo", inputSchema: { type: "object" } }],
					};
				case "prompts/list":
					return { resultType: "complete", prompts: [] };
				case "resources/list":
					return { resultType: "complete", resources: [{ uri: "test://data", name: "data" }] };
				case "resources/templates/list":
					return { resultType: "complete", resourceTemplates: [] };
				case "tools/call":
					return { resultType: "complete", content: [], ...options.toolResult };
				default:
					return { resultType: "complete" };
			}
		})();
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	const connection = new ServerConnection({
		serverName: "configured-fixture",
		config: normalizeServer({ type: "http", url: `http://127.0.0.1:${address.port}/mcp`, auth: false }),
		logger: createMcpLogger("triage", { logDir: root }),
	});
	const close = async () => {
		try {
			await connection.dispose();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rm(root, { recursive: true, force: true });
		}
	};
	try {
		await connection.connect();
		return { client: connection.client, connection, requests, streams, next, close };
	} catch (error) {
		await close();
		throw error;
	}
}
