import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeServer } from "../../../src/core/extensions/builtin/mcp/config.ts";
import { ServerConnection } from "../../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../../src/core/extensions/builtin/mcp/log.ts";

export async function openHeaderFixture(
	tools: unknown[],
	options: { legacy?: boolean; headers?: Record<string, string>; sse?: boolean } = {},
) {
	const requests: Array<{
		message: { id: string | number; method: string; params?: Record<string, unknown> };
		headers: IncomingHttpHeaders;
	}> = [];
	const root = await mkdtemp(join(tmpdir(), "senpi-header-http-"));
	const server = createServer(async (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(request.method === "DELETE" ? 204 : 405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString());
		requests.push({ message, headers: request.headers });
		if (message.method === "server/discover" && options.legacy) {
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown" } }));
			return;
		}
		if (message.method === "notifications/initialized") {
			response.writeHead(202).end();
			return;
		}
		const result = (() => {
			switch (message.method) {
				case "server/discover":
					return {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
						_meta: { "io.modelcontextprotocol/serverInfo": { name: "synthetic-peer", version: "1" } },
					};
				case "initialize":
					return {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "legacy", version: "1" },
					};
				case "tools/list":
					return { tools };
				default:
					return { content: [] };
			}
		})();
		const reply = { jsonrpc: "2.0", id: message.id, result };
		response.writeHead(200, { "Content-Type": options.sse ? "text/event-stream" : "application/json" });
		response.end(options.sse ? `data: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	const logger = createMcpLogger("headers", { logDir: root });
	const connection = new ServerConnection({
		serverName: "configured-fixture",
		config: normalizeServer({
			type: "http",
			url: `http://127.0.0.1:${address.port}/mcp`,
			auth: false,
			...("headers" in options ? { headers: options.headers } : {}),
		}),
		logger,
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
		return { client: connection.client, requests, tools, logger, close };
	} catch (error) {
		await close();
		throw error;
	}
}
