import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config-schema.ts";
import { createMcpLogger } from "../log.ts";
import { connectMcpTransport, createMcpTransport, shutdownMcpTransport } from "../transport.ts";
import { materializeMcpTransport } from "../transport-sdk.ts";
import { MODERN_PROTOCOL_VERSION } from "./wire.ts";

const config: McpServerConfig = {
	type: "http",
	url: "https://fixture.test/mcp",
	args: [],
	enabled: true,
	exposure: "auto",
	lifecycle: "lazy",
	idleTimeoutMin: 10,
	connectTimeoutMs: 2000,
	requestTimeoutMs: 2000,
	startupTimeoutMs: 250,
	logLevel: "info",
};
const discovery = {
	resultType: "complete",
	supportedVersions: [MODERN_PROTOCOL_VERSION],
	capabilities: { tools: {} },
	_meta: { "io.modelcontextprotocol/serverInfo": { name: "modern", version: "1" } },
	instructions: "Modern instructions",
};
afterEach(() => vi.unstubAllGlobals());

describe("dual-era factory dispatch", () => {
	it("discovers a modern server once, connects without legacy traffic, and logs its real version", async () => {
		const methods: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				methods.push(request.method);
				const headers = new Headers(init?.headers);
				expect(init?.method).toBe("POST");
				expect(headers.get("Authorization")).toBe("Bearer fixture");
				expect(headers.get("MCP-Protocol-Version")).toBe(MODERN_PROTOCOL_VERSION);
				expect(headers.get("Mcp-Method")).toBe(request.method);
				expect(headers.has("Mcp-Session-Id")).toBe(false);
				expect(headers.has("Mcp-Name")).toBe(false);
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					result: request.method === "server/discover" ? discovery : { resultType: "complete", tools: [] },
				});
			}),
		);
		const root = await mkdtemp(join(tmpdir(), "mcp-modern-"));
		const logger = createMcpLogger("modern", { logDir: root });
		const connection = createMcpTransport({
			config: {
				...config,
				auth: "bearer",
				bearerTokenEnv: "FIXTURE",
				headers: { "Mcp-Name": "stale", "Mcp-Session-Id": "stale", "MCP-Protocol-Version": "stale" },
			},
			env: { FIXTURE: "fixture" },
			logger,
			serverName: "modern",
		});
		try {
			await Promise.all([connection.materialize(), connection.materialize()]);
			await connectMcpTransport(connection);
			expect(connection.client.getInstructions()).toBe("Modern instructions");
			expect((await connection.client.listTools()).tools).toEqual([]);
			expect(methods).toEqual(["server/discover", "tools/list"]);
			expect(logger.getRingBuffer().filter((line) => line.includes("era=modern version=2026-07-28"))).toHaveLength(
				1,
			);
		} finally {
			await shutdownMcpTransport(connection);
			await rm(root, { recursive: true, force: true });
		}
		expect(methods).toEqual(["server/discover", "tools/list"]);
	});

	// senpi#4402: the real SDK must negotiate an advertised legacy version after the probe selects legacy.
	it.each([400, 404, -32022])(
		"keeps legacy requests byte-identical after an HTTP %s discovery rejection",
		async (status) => {
			const wire: { method: string; body: string | undefined; headers: [string, string][] }[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: string | URL, init?: RequestInit) => {
					const body = typeof init?.body === "string" ? init.body : undefined;
					const request = body ? JSON.parse(body) : undefined;
					wire.push({ method: String(init?.method), body, headers: [...new Headers(init?.headers)] });
					if (request?.method === "server/discover") {
						return status === -32022
							? Response.json(
									{
										jsonrpc: "2.0",
										id: request.id,
										error: {
											code: -32022,
											message: "UnsupportedProtocolVersionError",
											data: { supported: ["2025-06-18", "2025-03-26"] },
										},
									},
									{ status: 400 },
								)
							: new Response("", { status });
					}
					if (init?.method !== "POST") return new Response(null, { status: 405 });
					if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
					return Response.json(
						{
							jsonrpc: "2.0",
							id: request.id,
							result:
								request.method === "initialize"
									? {
											protocolVersion: status === -32022 ? "2025-06-18" : request.params.protocolVersion,
											capabilities: { tools: {} },
											serverInfo: { name: "legacy", version: "1" },
										}
									: { tools: [] },
						},
						{ headers: { "Mcp-Session-Id": "fixture-session" } },
					);
				}),
			);
			const root = await mkdtemp(join(tmpdir(), "mcp-legacy-"));
			const logger = createMcpLogger("legacy", { logDir: root });
			const baseline = await materializeMcpTransport({
				spec: { kind: "http", url: new URL(config.url ?? ""), authProvider: undefined, requestInit: undefined },
				logger,
				sink: { logger },
				onStart: () => {},
				elicitationUiProvider: undefined,
			});
			try {
				await baseline.client.connect(baseline.transport);
				await baseline.client.listTools();
			} finally {
				await baseline.close();
			}
			const expected = wire.splice(0);
			const connection = createMcpTransport({ config, logger, serverName: "legacy" });
			try {
				await connectMcpTransport(connection);
				await connection.client.listTools();
				if (status === -32022) {
					expect(logger.getRingBuffer().some((line) => line.includes("era=legacy version=2025-06-18"))).toBe(true);
				}
			} finally {
				await shutdownMcpTransport(connection);
				await rm(root, { recursive: true, force: true });
			}
			expect(JSON.parse(wire[0]?.body ?? "{}").method).toBe("server/discover");
			expect(wire.slice(1)).toEqual(expected);
		},
	);

	it("does not downgrade a recognized modern error to SDK initialize", async () => {
		const methods: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				methods.push(request.method);
				return Response.json(
					{ jsonrpc: "2.0", id: request.id, error: { code: -32021, message: "Missing capability" } },
					{ status: 400 },
				);
			}),
		);
		const root = await mkdtemp(join(tmpdir(), "mcp-error-"));
		const connection = createMcpTransport({
			config,
			logger: createMcpLogger("modern", { logDir: root }),
			serverName: "modern",
		});
		try {
			await expect(connectMcpTransport(connection)).rejects.toThrow(/modern discovery failed/);
			expect(methods).toEqual(["server/discover"]);
		} finally {
			await shutdownMcpTransport(connection);
			await rm(root, { recursive: true, force: true });
		}
	});
});
