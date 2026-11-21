import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	configureMcpReconnect,
	disposeMcpReconnect,
	getMcpReconnectDebugSnapshot,
	reconnectMcpNow,
} from "../../src/core/extensions/builtin/mcp/reconnect.ts";
import { serverConfig } from "./fixtures/reconnect.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
});

/** A never-ready server's connection whose reconnects log into an agent dir the test removes, as a host's teardown does. */
async function neverReady(name: string) {
	const agentDir = await mkdtemp(join(tmpdir(), `senpi-mcp-4642-${name}-`));
	cleanupTasks.push(() => rm(agentDir, { recursive: true, force: true }));
	const logger = createMcpLogger(name, { logDir: join(agentDir, "logs", "mcp") });
	const connection = new ServerConnection({ config: serverConfig(), logger, serverName: name });
	cleanupTasks.push(() => connection.dispose());
	let attempts = 0;
	const gate = Promise.withResolvers<void>();
	configureMcpReconnect({
		connection,
		logger,
		random: () => 1,
		reconnect: async () => {
			attempts += 1;
			logger.info(`MCP server ${name}: reconnecting`);
			await gate.promise;
			throw new Error("transport closed");
		},
	});
	return { agentDir, connection, logger, attempts: () => attempts, gate };
}

describe("dispose stops every reconnect before it can write (senpi#4642)", () => {
	it("#given a degraded server whose first reconnect waits on its backoff timer #when dispose lands during the wait #then no reconnect ever starts and nothing is written", async () => {
		// given
		vi.useFakeTimers();
		const server = await neverReady("backoff");
		server.connection.markDegraded(new Error("closed"));
		expect(getMcpReconnectDebugSnapshot(server.connection).timerHasRef).not.toBeNull();

		// when: dispose during the 500 ms backoff, then the agent dir is removed and time runs well past every backoff
		await disposeMcpReconnect(server.connection);
		await rm(server.agentDir, { recursive: true, force: true });
		await vi.advanceTimersByTimeAsync(60_000);

		// then
		expect(server.attempts()).toBe(0);
		expect(getMcpReconnectDebugSnapshot(server.connection).timerHasRef).toBeNull();
		expect(existsSync(server.agentDir)).toBe(false);
	});

	it("#given a reconnect attempt in flight #when dispose lands #then dispose settles only after that attempt, which neither degrades the connection nor schedules another", async () => {
		// given
		const server = await neverReady("inflight");
		const attempt = reconnectMcpNow(server.connection).catch((error: unknown) => error);
		await vi.waitFor(() => expect(server.attempts()).toBe(1));

		// when
		let disposed = false;
		// Promise.resolve: before senpi#4642 dispose returned nothing, so a caller could not wait for the attempt.
		const disposing = Promise.resolve(disposeMcpReconnect(server.connection)).then(() => {
			disposed = true;
		});
		await Promise.resolve();
		const settledBeforeAttempt = disposed;
		server.gate.resolve();
		await disposing;
		await attempt;
		await rm(server.agentDir, { recursive: true, force: true });

		// then
		expect(settledBeforeAttempt).toBe(false);
		expect(server.attempts()).toBe(1);
		expect(server.connection.state).not.toBe("degraded");
		expect(getMcpReconnectDebugSnapshot(server.connection).timerHasRef).toBeNull();
		expect(existsSync(server.agentDir)).toBe(false);
	});
});
