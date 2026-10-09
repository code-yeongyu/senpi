import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cache from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { loadMcpConfig } from "../../src/core/extensions/builtin/mcp/config.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import {
	disposeMcpConnectionLifecycle,
	getMcpLifecycleDebugSnapshot,
} from "../../src/core/extensions/builtin/mcp/idle.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	configureMcpReconnect,
	disposeMcpReconnect,
	getMcpReconnectDebugSnapshot,
} from "../../src/core/extensions/builtin/mcp/reconnect.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import type { McpConnectionEntry } from "../../src/core/extensions/builtin/mcp/service-types.ts";
import { connectAndRefreshMcpCatalog } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import { serverConfig } from "./fixtures/reconnect.ts";
import { attach, cleanupRoots, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const connections: ServerConnection[] = [];
const services: McpService[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(services.splice(0).map((service) => service.dispose("quit")));
	for (const connection of connections.splice(0)) {
		disposeMcpReconnect(connection);
		disposeMcpConnectionLifecycle(connection);
		await connection.dispose();
	}
	await cleanupRoots(cleanupTasks);
});

// senpi#1915: pin the existing per-connection contract before registry injection.
describe("MCP registry characterization", () => {
	it("keeps equal-config services isolated and arms idle timers per connection", async () => {
		const root = makeRoot("registry-isolation", cleanupTasks);
		setConfig(root, { fx: { ...stdioServer(["--tools", "1"]), lifecycle: "eager" } });
		const first = new McpService();
		const second = new McpService();
		services.push(first, second);

		await attach(first, root, "startup");
		await attach(second, root, "startup");
		expect(await first.whenAttachSettled(10_000)).toBe("settled");
		expect(await second.whenAttachSettled(10_000)).toBe("settled");
		const a = first.getConnection("fx");
		const b = second.getConnection("fx");
		if (!a || !b) throw new Error("missing fixture connections");
		expect(a).not.toBe(b);
		expect(a.getRootPid()).not.toBe(b.getRootPid());
		expect(getMcpLifecycleDebugSnapshot(a)?.idleTimerHasRef).toBe(false);
		expect(getMcpLifecycleDebugSnapshot(b)?.idleTimerHasRef).toBe(false);

		await first.dispose("quit");
		expect(a.state).toBe("disabled");
		expect(b.state).toBe("connected");
		expect(getMcpLifecycleDebugSnapshot(b)?.idleTimerHasRef).toBe(false);
		expect((await b.client.callTool({ name: "tool_1", arguments: { value: "survivor" } })).isError).not.toBe(true);
	});

	it("cancels only the disposed connection's reconnect timer", async () => {
		vi.useFakeTimers();
		const root = makeRoot("registry-reconnect", cleanupTasks);
		const logger = createMcpLogger("registry", { logDir: root.agentDir });
		const a = new ServerConnection({ serverName: "a", config: serverConfig(), logger });
		const b = new ServerConnection({ serverName: "b", config: serverConfig(), logger });
		connections.push(a, b);
		let aAttempts = 0;
		let bAttempts = 0;
		configureMcpReconnect({
			connection: a,
			logger,
			random: () => 0.5,
			reconnect: async () => {
				aAttempts++;
			},
		});
		configureMcpReconnect({
			connection: b,
			logger,
			random: () => 0.5,
			reconnect: async () => {
				bAttempts++;
			},
		});
		a.markDegraded(new Error("a closed"));
		b.markDegraded(new Error("b closed"));
		expect(getMcpReconnectDebugSnapshot(a).timerHasRef).toBe(false);
		expect(getMcpReconnectDebugSnapshot(b).timerHasRef).toBe(false);

		disposeMcpReconnect(a);
		await vi.advanceTimersByTimeAsync(250);

		expect(aAttempts).toBe(0);
		expect(bAttempts).toBe(1);
	});

	it("writes the real catalog exactly once per connected generation", async () => {
		const root = makeRoot("registry-cache", cleanupTasks);
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const server = loadMcpConfig({ ...root, projectTrusted: true }).servers.fx;
		if (!server?.config || !server.configHash) throw new Error("missing fixture config");
		const logger = createMcpLogger("fx", { logDir: root.agentDir });
		const connection = new ServerConnection({ serverName: "fx", config: server.config, logger });
		connections.push(connection);
		const entry: McpConnectionEntry = {
			key: `fx\0${server.configHash}`,
			name: "fx",
			configHash: server.configHash,
			connection,
			logger,
			agentDir: root.agentDir,
			createdAtMs: Date.now(),
			counters: { callCount: 0, errorCount: 0, totalLatencyMs: 0, reconnectCount: 0 },
			cacheRefreshedAfterConnect: false,
		};
		const writes = vi.spyOn(cache, "writeMcpCachedServer");

		await connectAndRefreshMcpCatalog(entry, server.config);
		const firstBytes = await readFile(cache.getMcpCatalogCachePath(root.agentDir), "utf8");
		await connectAndRefreshMcpCatalog(entry, server.config);

		expect(writes).toHaveBeenCalledTimes(1);
		expect(await readFile(cache.getMcpCatalogCachePath(root.agentDir), "utf8")).toBe(firstBytes);
		expect((await cache.readMcpCatalogCache(root.agentDir)).servers.fx?.tools.map((tool) => tool.name)).toEqual([
			"tool_1",
		]);

		await connection.bumpGeneration();
		entry.cacheRefreshedAfterConnect = false;
		await connectAndRefreshMcpCatalog(entry, server.config);
		expect(writes).toHaveBeenCalledTimes(2);
		expect(connection.state).toBe("connected");
	});
});
