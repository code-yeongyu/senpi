import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { TimeoutError } from "../../src/core/extensions/builtin/mcp/errors.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import * as transports from "../../src/core/extensions/builtin/mcp/transport.ts";
import { stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

vi.mock("../../src/core/extensions/builtin/mcp/transport.ts", async (original) => ({
	...(await original<typeof transports>()),
	createMcpTransport: vi.fn((await original<typeof transports>()).createMcpTransport),
	connectMcpTransport: vi.fn((await original<typeof transports>()).connectMcpTransport),
	shutdownMcpTransport: vi.fn((await original<typeof transports>()).shutdownMcpTransport),
}));

afterEach(() => vi.restoreAllMocks());

describe("MCP renewal ownership (senpi#3915)", () => {
	it("waits for failed-connect cleanup before a renewal can spawn", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-mcp-failed-renewal-"));
		const fixture = stdioFixtureCommand();
		const connection = new ServerConnection({
			serverName: "failed-renewal",
			logger: createMcpLogger("failed-renewal", { logDir: root }),
			config: {
				type: "stdio",
				command: fixture.command,
				args: [...fixture.args, "--tools", "1"],
				enabled: true,
				exposure: "auto",
				lifecycle: "lazy",
				idleTimeoutMin: 10,
				connectTimeoutMs: 15_000,
				requestTimeoutMs: 15_000,
				startupTimeoutMs: 250,
				logLevel: "info",
			},
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const connect = vi.mocked(transports.connectMcpTransport).getMockImplementation();
		const shutdown = vi.mocked(transports.shutdownMcpTransport).getMockImplementation();
		if (connect === undefined || shutdown === undefined) throw new Error("missing real transport implementation");
		let originalPid: number | null = null;
		vi.mocked(transports.connectMcpTransport).mockImplementationOnce(async (transport) => {
			await connect(transport);
			originalPid = transport.getRootPid();
			throw new TimeoutError("forced handshake timeout", { phase: "connect", serverName: "failed-renewal" });
		});
		vi.mocked(transports.shutdownMcpTransport).mockImplementationOnce(async (transport) => {
			entered.resolve();
			await release.promise;
			await shutdown(transport);
		});
		const pending = connection.connect();
		const rejected = expect(pending).rejects.toThrow(/superseded/);
		let renewal: Promise<unknown> | undefined;
		try {
			await entered.promise;
			const before = vi.mocked(transports.createMcpTransport).mock.calls.length;
			// Observe the renewal's existing idle event, after it has captured its teardown barrier.
			const invalidated = Promise.withResolvers<void>();
			const off = connection.onStateChange((event) => {
				if (event.state === "idle") invalidated.resolve();
			});
			renewal = connection.renew();
			await invalidated.promise;
			off();
			// Drain the resolved-promise chain before inspecting creation; no wall-clock delay is involved.
			await setImmediate();
			const spawned = vi.mocked(transports.createMcpTransport).mock.calls.length > before;
			const overlappingPids: number[] = [];
			if (spawned) {
				await renewal;
				const replacementPid = connection.getRootPid();
				if (originalPid === null || replacementPid === null) throw new Error("missing fixture PID");
				process.kill(originalPid, 0);
				process.kill(replacementPid, 0);
				overlappingPids.push(originalPid, replacementPid);
			}
			release.resolve();
			await Promise.all([rejected, renewal]);
			expect(overlappingPids, "failed connect and replacement are simultaneously alive").toEqual([]);
			expect(spawned).toBe(false);
		} finally {
			release.resolve();
			await Promise.allSettled([pending, rejected, renewal]);
			await connection.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ operation: "renew", competitor: "connect" },
		{ operation: "renew", competitor: "renew" },
		{ operation: "bumpGeneration", competitor: "connect" },
	] as const)(
		"does not spawn on $competitor while $operation is still disposing the old process",
		async ({ operation, competitor }) => {
			// Given a real live server whose teardown is held at the existing transport seam.
			const root = await mkdtemp(join(tmpdir(), "senpi-mcp-renewal-"));
			const fixture = stdioFixtureCommand();
			const connection = new ServerConnection({
				serverName: "renewal",
				logger: createMcpLogger("renewal", { logDir: root }),
				config: {
					type: "stdio",
					command: fixture.command,
					args: [...fixture.args, "--tools", "1"],
					enabled: true,
					exposure: "auto",
					lifecycle: "lazy",
					idleTimeoutMin: 10,
					connectTimeoutMs: 15_000,
					requestTimeoutMs: 15_000,
					startupTimeoutMs: 250,
					logLevel: "info",
				},
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const shutdown = vi.mocked(transports.shutdownMcpTransport).getMockImplementation();
			if (shutdown === undefined) throw new Error("missing real transport shutdown");
			const competing: Promise<unknown>[] = [];
			try {
				await connection.connect();
				const originalPid = connection.getRootPid();
				if (originalPid === null) throw new Error("missing original fixture PID");
				vi.mocked(transports.shutdownMcpTransport).mockImplementationOnce(async (transport) => {
					entered.resolve();
					await release.promise;
					await shutdown(transport);
				});

				// When another caller connects or retries renewal before teardown has completed.
				const retiring = connection[operation]();
				competing.push(retiring);
				await entered.promise;
				const before = vi.mocked(transports.createMcpTransport).mock.calls.length;
				const next = connection[competitor]();
				competing.push(next);
				const sameRenewal = competitor !== "renew" || next === retiring;
				const overlappingPids: number[] = [];
				// Capture the production consequence on a broken implementation, not just a mock call count.
				if (vi.mocked(transports.createMcpTransport).mock.calls.length > before || !sameRenewal) {
					await next;
					const replacementPid = connection.getRootPid();
					process.kill(originalPid, 0);
					if (replacementPid === null) throw new Error("missing replacement fixture PID");
					process.kill(replacementPid, 0);
					overlappingPids.push(originalPid, replacementPid);
				}
				const spawnedDuringTeardown = vi.mocked(transports.createMcpTransport).mock.calls.length - before;
				release.resolve();
				await Promise.all(competing);

				// Then no replacement exists until the retiring process has been reaped.
				expect(overlappingPids, "simultaneously live fixture PIDs before teardown release").toEqual([]);
				expect(spawnedDuringTeardown).toBe(0);
				expect(sameRenewal).toBe(true);
				expect(connection.state).toBe("connected");
			} finally {
				release.resolve();
				await Promise.allSettled(competing);
				await connection.dispose();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
