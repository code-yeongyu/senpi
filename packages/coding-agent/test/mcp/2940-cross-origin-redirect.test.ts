import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	connectMcpTransport,
	createMcpTransport,
	type McpTransportConnection,
	shutdownMcpTransport,
} from "../../src/core/extensions/builtin/mcp/transport.ts";

// senpi#2940: since @modelcontextprotocol/sdk 1.32 the HTTP transport follows a redirect only within the
// endpoint's origin. senpi keeps that default; a cross-origin redirect must fail with an error that names both
// origins and says why it was refused, instead of the SDK's bare status text.

const servers: Server[] = [];
const connections: McpTransportConnection[] = [];
afterEach(async () => {
	await Promise.all(connections.splice(0).map((connection) => shutdownMcpTransport(connection)));
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function httpConfig(url: string): McpServerConfig {
	return {
		type: "http",
		url,
		args: [],
		enabled: true,
		lifecycle: "lazy",
		connectTimeoutMs: 4000,
		requestTimeoutMs: 4000,
		startupTimeoutMs: 250,
		idleTimeoutMin: 10,
		exposure: "auto",
		logLevel: "info",
		auth: false,
	};
}

describe("MCP HTTP endpoint redirected to another origin (senpi#2940)", () => {
	it("#given an endpoint that redirects to a different origin #when connecting #then the error names both origins and the same-origin rule", async () => {
		// given
		const target = await listen((_req, res) => {
			res.writeHead(500).end("the redirect must not be followed");
		});
		const endpoint = await listen((_req, res) => {
			res.writeHead(307, { location: `${target}/mcp` }).end();
		});
		const connection = createMcpTransport({
			config: httpConfig(`${endpoint}/mcp`),
			logger: createMcpLogger("redirect"),
			serverName: "moved",
		});
		connections.push(connection);

		// when
		const failure = await connectMcpTransport(connection).then(
			() => undefined,
			(error: unknown) => error,
		);

		// then
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain(new URL(endpoint).origin);
		expect(message).toContain(new URL(target).origin);
	});
});
