import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthFlowError } from "../../src/core/extensions/builtin/mcp/auth/oauth-errors.ts";
import type { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger, type McpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	configureMcpReconnect,
	disposeMcpReconnect,
	reconnectMcpNow,
} from "../../src/core/extensions/builtin/mcp/reconnect.ts";
import type { McpConnectionEntry } from "../../src/core/extensions/builtin/mcp/service-types.ts";
import { connectAndRefreshMcpCatalog } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import type { McpTransportConnection } from "../../src/core/extensions/builtin/mcp/transport.ts";

const transportControl = vi.hoisted(() => ({
	attempts: [] as Array<(error: Error) => void>,
	waiters: [] as Array<{ count: number; resolve: () => void }>,
}));

vi.mock("../../src/core/extensions/builtin/mcp/transport.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/extensions/builtin/mcp/transport.ts")>();
	return {
		...actual,
		createMcpTransport: (options: { serverName: string }): Partial<McpTransportConnection> => ({
			serverName: options.serverName,
			transportKind: "stdio",
			connectTimeoutMs: 60_000,
			transport: {} as McpTransportConnection["transport"],
			materialize: async () => undefined,
			getRootPid: () => null,
			closeTransport: async () => undefined,
		}),
		// Each handshake settles only when the test says so: a transport whose close lands after shutdown returned.
		connectMcpTransport: () =>
			new Promise<void>((_, reject) => {
				transportControl.attempts.push(reject);
				transportControl.waiters = transportControl.waiters.filter((waiter) => {
					if (transportControl.attempts.length < waiter.count) return true;
					waiter.resolve();
					return false;
				});
			}),
		shutdownMcpTransport: async () => undefined,
	};
});

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
	transportControl.attempts = [];
	transportControl.waiters = [];
	for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
});

function attemptStarted(count: number): Promise<void> {
	if (transportControl.attempts.length >= count) return Promise.resolve();
	return new Promise((resolve) => transportControl.waiters.push({ count, resolve }));
}

function failAttempt(index: number): void {
	const reject = transportControl.attempts[index];
	if (reject === undefined) throw new Error(`no handshake attempt #${index}`);
	reject(new Error("transport closed"));
}

function serverConfig(): McpServerConfig {
	return {
		args: [],
		command: "never-ready",
		connectTimeoutMs: 60_000,
		enabled: true,
		exposure: "auto",
		idleTimeoutMin: 10,
		lifecycle: "eager",
		logLevel: "info",
		requestTimeoutMs: 30_000,
		startupTimeoutMs: 250,
		type: "stdio",
	};
}

async function fixture(
	authPlan?: McpConnectionEntry["authPlan"],
): Promise<{ connection: ServerConnection; entry: McpConnectionEntry; logger: McpLogger }> {
	const logDir = await mkdtemp(join(tmpdir(), "senpi-mcp-4013-"));
	cleanupTasks.push(() => rm(logDir, { recursive: true, force: true }));
	const logger = createMcpLogger("never-ready", { logDir });
	const connection = new ServerConnection({ serverName: "never-ready", config: serverConfig(), logger });
	cleanupTasks.push(() => connection.dispose());
	const entry: McpConnectionEntry = {
		key: "never-ready\0hash",
		name: "never-ready",
		configHash: "hash",
		connection,
		logger,
		createdAtMs: Date.now(),
		counters: { callCount: 0, errorCount: 0, totalLatencyMs: 0, reconnectCount: 0 },
		cacheRefreshedAfterConnect: false,
		...(authPlan === undefined ? {} : { authPlan }),
	};
	return { connection, entry, logger };
}

function readLog(logger: McpLogger): string | undefined {
	return existsSync(logger.filePath) ? readFileSync(logger.filePath, "utf8") : undefined;
}

describe("a connect or reconnect superseded by dispose or renew is not a server failure (senpi#4013)", () => {
	it("#given a startup connect whose transport closes only after dispose returned #when that attempt then fails #then nothing is logged and the connection stays disabled", async () => {
		// given
		const { connection, entry, logger } = await fixture();
		const attempt = connectAndRefreshMcpCatalog(entry, serverConfig());
		await attemptStarted(1);
		expect(connection.state).toBe("connecting");

		// when
		await connection.dispose();
		const atDispose = readLog(logger);
		failAttempt(0);
		await attempt;

		// then
		expect(readLog(logger)).toBe(atDispose);
		expect(connection.state).toBe("disabled");
	});

	it("#given a reconnect in flight #when dispose lands and the reconnect then fails #then the connection stays disabled, still refuses renew, and nothing is logged", async () => {
		// given
		const { connection, entry, logger } = await fixture();
		configureMcpReconnect({
			connection,
			logger,
			random: () => 0.5,
			reconnect: async () => {
				await connection.renew();
				await connectAndRefreshMcpCatalog(entry, serverConfig());
			},
		});
		cleanupTasks.push(async () => disposeMcpReconnect(connection));
		const reconnecting = reconnectMcpNow(connection).catch((error: unknown) => error);
		await attemptStarted(1);

		// when: the service disposes the reconnect first, then the connection; then the aborted handshake fails late
		disposeMcpReconnect(connection);
		await connection.dispose();
		const atDispose = readLog(logger);
		failAttempt(0);
		await reconnecting;

		// then
		expect(connection.state).toBe("disabled");
		await expect(connection.renew()).rejects.toThrow("is disabled");
		expect(readLog(logger)).toBe(atDispose);
	});

	it("#given a startup connect in flight #when a renew supersedes it and it then fails #then the replacement attempt is not degraded and nothing is logged", async () => {
		// given
		const { connection, entry, logger } = await fixture();
		const first = connectAndRefreshMcpCatalog(entry, serverConfig());
		await attemptStarted(1);
		const beforeRenew = readLog(logger);

		// when
		const renewing = connection.renew().catch((error: unknown) => error);
		await attemptStarted(2);
		failAttempt(0);
		await first;

		// then
		expect(connection.state).toBe("connecting");
		expect(readLog(logger)).toBe(beforeRenew);
		await connection.dispose();
		failAttempt(1);
		await renewing;
	});

	it("#given an OAuth refresh in flight at startup #when dispose lands and the refresh then needs auth #then nothing is logged and the connection stays disabled", async () => {
		// given
		let failRefresh: ((error: Error) => void) | undefined;
		let refreshBegan: (() => void) | undefined;
		const refreshStarted = new Promise<void>((started) => {
			refreshBegan = started;
		});
		const refresh = {
			ensureFresh: () =>
				new Promise<never>((_, reject) => {
					failRefresh = reject;
					refreshBegan?.();
				}),
		};
		const { connection, entry, logger } = await fixture({
			mode: "oauth",
			refresh: refresh as unknown as McpRefreshManager,
		});
		const attempt = connectAndRefreshMcpCatalog(entry, serverConfig());
		await refreshStarted;

		// when
		await connection.dispose();
		const atDispose = readLog(logger);
		failRefresh?.(new OAuthFlowError("needs_auth", "MCP server never-ready needs auth"));
		await attempt.catch((error: unknown) => error);

		// then
		expect(readLog(logger)).toBe(atDispose);
		expect(connection.state).toBe("disabled");
	});
});
