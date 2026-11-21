import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthFlowError } from "../auth/oauth-errors.ts";
import type { McpServerConfig } from "../config-schema.ts";
import { normalizeServer } from "../config.ts";
import { ServerConnection } from "../connection.ts";
import { AuthError } from "../errors.ts";
import { ensureMcpToolCallConnection } from "../health.ts";
import { HostMcpRegistry } from "../host-registry.ts";
import { configureMcpConnectionLifecycle, disposeMcpConnectionLifecycle } from "../idle.ts";
import { createMcpLogger } from "../log.ts";
import { SharedMcpLease } from "../shared-lease.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function modernHealthServer(failure?: "auth" | "transport"): string[] {
	const methods: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string | URL, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body));
			methods.push(request.method);
			if (methods.length > 1 && failure === "auth") return new Response(null, { status: 401 });
			if (methods.length > 1 && failure === "transport") throw new TypeError("connection lost");
			if (request.method !== "server/discover") {
				return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Not found" } });
			}
			return Response.json({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					resultType: "complete",
					supportedVersions: ["2026-07-28"],
					capabilities: {},
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
				},
			});
		}),
	);
	return methods;
}

async function connectionFixture(overrides: Partial<McpServerConfig> = {}) {
	const root = await mkdtemp(join(tmpdir(), "mcp-discovery-"));
	const connection = new ServerConnection({
		serverName: "fixture",
		logger: createMcpLogger("fixture", { logDir: root }),
		config: {
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
			...overrides,
		},
	});
	return {
		connection,
		cleanup: async () => {
			await connection.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("discovery connection ownership", () => {
	// senpi#6617: modern servers reject ping but remain connected after health validation.
	it("validates stale modern connections without restarting or probing fresh calls", async () => {
		const methods = modernHealthServer();
		const { connection, cleanup } = await connectionFixture();
		try {
			await connection.connect();
			const generation = connection.generation;
			vi.useFakeTimers({ toFake: ["Date"] });
			await ensureMcpToolCallConnection(connection);
			await ensureMcpToolCallConnection(connection);
			vi.setSystemTime(Date.now() + 31_000);
			await ensureMcpToolCallConnection(connection);
			expect(connection.generation).toBe(generation);
			expect(connection.state).toBe("connected");
			expect(methods).toEqual(["server/discover", "server/discover", "server/discover"]);
		} finally {
			await cleanup();
		}
	});

	it("surfaces lost authentication during pre-call health validation without dispatching a tool", async () => {
		const methods: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				methods.push(request.method);
				if (methods.length > 1) return new Response(null, { status: 401 });
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: {},
						_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
					},
				});
			}),
		);
		const { connection, cleanup } = await connectionFixture();
		try {
			await connection.connect();
			await expect(ensureMcpToolCallConnection(connection)).rejects.toBeInstanceOf(Error);
			expect(methods).not.toContain("tools/call");
		} finally {
			await cleanup();
		}
	});

	it.each(["ordinary", "shared"] as const)("keeps a modern %s connection alive without ping", async (kind) => {
		const methods = modernHealthServer();
		const root = await mkdtemp(join(tmpdir(), "mcp-modern-keepalive-"));
		const logger = createMcpLogger("fixture", { logDir: root });
		const config = normalizeServer({ type: "http", url: "https://fixture.test/mcp", lifecycle: "keep-alive" });
		const registry = new HostMcpRegistry();
		const ordinary = await connectionFixture();
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const connection =
			kind === "shared"
				? registry.attachShared(
						"fixture",
						{},
						{ serverName: "fixture", config, configHash: "fixture", agentDir: root, logger },
					)
				: ordinary.connection;
		try {
			await connection.connect();
			const generation = connection.generation;
			if (kind === "ordinary") configureMcpConnectionLifecycle(ordinary.connection, config, logger);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(connection.state).toBe("connected");
			expect(connection.generation).toBe(generation);
			expect(methods).toEqual(["server/discover", "server/discover"]);
		} finally {
			disposeMcpConnectionLifecycle(ordinary.connection);
			await registry.dispose();
			await ordinary.cleanup();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["ordinary", "auth", "degraded"],
		["ordinary", "transport", "degraded"],
		["shared", "auth", "connected"],
		["shared", "transport", "degraded"],
	] as const)("reports %s %s probe failure as %s", async (kind, failure, expectedState) => {
		const methods = modernHealthServer(failure);
		const root = await mkdtemp(join(tmpdir(), "mcp-modern-failure-"));
		const logger = createMcpLogger("fixture", { logDir: root });
		const config = normalizeServer({ type: "http", url: "https://fixture.test/mcp", lifecycle: "keep-alive" });
		const registry = new HostMcpRegistry();
		const ordinary = await connectionFixture();
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const connection =
			kind === "shared"
				? registry.attachShared(
						"fixture",
						{},
						{ serverName: "fixture", config, configHash: "fixture", agentDir: root, logger },
					)
				: ordinary.connection;
		try {
			await connection.connect();
			const states: string[] = [];
			const unsubscribe = connection.onStateChange((event) => {
				states.push(event.state);
			});
			if (kind === "ordinary") configureMcpConnectionLifecycle(ordinary.connection, config, logger);
			await vi.advanceTimersByTimeAsync(30_000);
			unsubscribe();
			if (expectedState === "connected") expect(states).toEqual([]);
			else expect(states).toContain(expectedState);
			expect(methods).toEqual(["server/discover", "server/discover"]);
		} finally {
			disposeMcpConnectionLifecycle(ordinary.connection);
			await registry.dispose();
			await ordinary.cleanup();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not degrade a replacement connection when an old shared health probe is aborted", async () => {
		const entered = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		let discoveries = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				if (request.method === "tools/call") {
					return Response.json({
						jsonrpc: "2.0",
						id: request.id,
						result: { resultType: "complete", content: [] },
					});
				}
				discoveries++;
				if (discoveries === 2) {
					return await new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => {
								reject(new Error("old request aborted"));
								aborted.resolve();
							},
							{ once: true },
						);
						entered.resolve();
					});
				}
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
						_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
					},
				});
			}),
		);
		const root = await mkdtemp(join(tmpdir(), "mcp-stale-health-"));
		const logger = createMcpLogger("fixture", { logDir: root });
		const config = normalizeServer({ type: "http", url: "https://fixture.test/mcp", lifecycle: "keep-alive" });
		const registry = new HostMcpRegistry();
		vi.spyOn(Math, "random").mockReturnValue(1);
		const initial = registry.attachShared(
			"fixture",
			{},
			{
				serverName: "fixture",
				config: { ...config, lifecycle: "eager" },
				configHash: "fixture",
				agentDir: root,
				logger,
			},
		);
		try {
			await initial.connect();
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const lease = registry.attachShared(
				"fixture",
				{},
				{ serverName: "fixture", config, configHash: "fixture", agentDir: root, logger },
			);
			if (!(lease instanceof SharedMcpLease)) throw new Error("expected shared lease");
			const states: string[] = [];
			const unsubscribe = lease.onStateChange((event) => {
				states.push(event.state);
			});
			await vi.advanceTimersByTimeAsync(30_000);
			await entered.promise;
			const renewal = lease.shared.connection.renew();
			await aborted.promise;
			await renewal;
			const generation = lease.generation;
			await vi.advanceTimersByTimeAsync(0);
			unsubscribe();
			expect(states).not.toContain("degraded");
			expect(lease.state).toBe("connected");
			expect(lease.generation).toBe(generation);
			expect(discoveries).toBe(3);
			expect((await lease.client.callTool({ name: "fixture" })).content).toEqual([]);
		} finally {
			await registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not run an automatic shared reconnect after authentication becomes required", async () => {
		let discoveries = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				discoveries++;
				if (discoveries === 2) throw new TypeError("connection lost");
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: {},
						_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
					},
				});
			}),
		);
		const root = await mkdtemp(join(tmpdir(), "mcp-auth-health-"));
		const logger = createMcpLogger("fixture", { logDir: root });
		const config = normalizeServer({ type: "http", url: "https://fixture.test/mcp", lifecycle: "keep-alive" });
		const registry = new HostMcpRegistry();
		vi.spyOn(Math, "random").mockReturnValue(1);
		const initial = registry.attachShared(
			"fixture",
			{},
			{
				serverName: "fixture",
				config: { ...config, lifecycle: "eager" },
				configHash: "fixture",
				agentDir: root,
				logger,
			},
		);
		try {
			await initial.connect();
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const originalSetTimeout = globalThis.setTimeout;
			const scheduled = Promise.withResolvers<() => void>();
			vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
				if (delay === 500 && args.length === 0) {
					scheduled.resolve(callback);
					return originalSetTimeout(() => {}, 2_147_483_647);
				}
				return originalSetTimeout(callback, delay, ...args);
			});
			const lease = registry.attachShared(
				"fixture",
				{},
				{ serverName: "fixture", config, configHash: "fixture", agentDir: root, logger },
			);
			const generation = lease.generation;
			await vi.advanceTimersByTimeAsync(30_000);
			expect(lease.state).toBe("degraded");
			const fireReconnect = await scheduled.promise;
			await expect(
				ensureMcpToolCallConnection(lease, async () => {
					throw new OAuthFlowError("invalid_grant", "fixture refresh failed");
				}),
			).rejects.toBeInstanceOf(AuthError);
			expect(lease.state).toBe("needs_auth");
			fireReconnect();
			expect(lease.state).toBe("needs_auth");
			expect(lease.generation).toBe(generation);
			expect(discoveries).toBe(2);
			await lease.renew();
			expect(lease.state).toBe("connected");
		} finally {
			await registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not respawn detected modern stdio for legacy failure diagnostics", async () => {
		const root = await mkdtemp(join(tmpdir(), "mcp-stdio-"));
		const receipt = join(root, "requests");
		const script = `
			const fs = require("node:fs");
			const readline = require("node:readline");
			fs.appendFileSync(process.argv[1], "spawn\\n");
			async function main() {
				for await (const line of readline.createInterface({ input: process.stdin })) {
					const request = JSON.parse(line);
					fs.appendFileSync(process.argv[1], request.method + "\\n");
					process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
						error: { code: -32020, message: "modern only" } }) + "\\n");
				}
			}
			main().catch(error => { console.error(error); process.exitCode = 1; });
		`;
		const { connection, cleanup } = await connectionFixture({
			type: "stdio",
			command: process.execPath,
			args: ["-e", script, receipt],
		});
		try {
			await expect(connection.connect()).rejects.toMatchObject({ phase: "modern-stdio" });
			expect(await readFile(receipt, "utf8")).toBe("spawn\nserver/discover\n");
			expect(connection.state).toBe("degraded");
		} finally {
			await cleanup();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aborts pending discovery on dispose without opening a legacy connection", async () => {
		const entered = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const fetch = vi.fn(
			(_url: string | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => {
							aborted.resolve();
							reject(init.signal?.reason);
						},
						{ once: true },
					);
					entered.resolve();
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const { connection, cleanup } = await connectionFixture();
		try {
			const pending = connection.connect();
			const rejected = expect(pending).rejects.toThrow(/superseded/);
			await entered.promise;
			await connection.dispose();
			await aborted.promise;
			await rejected;
			expect(fetch).toHaveBeenCalledOnce();
			expect(connection.state).toBe("disabled");
		} finally {
			await cleanup();
		}
	});

	it("publishes single flight before connecting listeners and diagnoses failed discovery", async () => {
		const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body));
			return Response.json(
				{ jsonrpc: "2.0", id: request.id, error: { code: -32021, message: "Missing required capability" } },
				{ status: 400 },
			);
		});
		vi.stubGlobal("fetch", fetch);
		const { connection, cleanup } = await connectionFixture();
		const observed: Promise<unknown>[] = [];
		connection.onStateChange((event) => {
			if (event.state === "connecting") observed.push(connection.connect());
		});
		try {
			const pending = connection.connect();
			const rejected = expect(pending).rejects.toThrow(/modern discovery failed/);
			await rejected;
			expect(observed).toEqual([pending]);
			expect(fetch).toHaveBeenCalledOnce();
			expect(connection.state).toBe("degraded");
			expect(connection.lastError?.message).toContain("modern discovery failed");
		} finally {
			await cleanup();
		}
	});
});
