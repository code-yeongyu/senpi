import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger, type McpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	configureMcpReconnect,
	disposeMcpReconnect,
	MCP_RECONNECT_DISPOSE_WAIT_MS,
	reconnectMcpNow,
} from "../../src/core/extensions/builtin/mcp/reconnect.ts";
import { serverConfig } from "./fixtures/reconnect.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
});

async function tempDir(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `senpi-mcp-4642-${name}-`));
	cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function readLog(logger: McpLogger): string | undefined {
	return existsSync(logger.filePath) ? readFileSync(logger.filePath, "utf8") : undefined;
}

async function connectionWithReconnect(name: string, reconnect: (signal: AbortSignal) => Promise<void>) {
	const logger = createMcpLogger(name, { logDir: join(await tempDir(name), "logs", "mcp") });
	const connection = new ServerConnection({ config: serverConfig(), logger, serverName: name });
	cleanupTasks.push(() => connection.dispose());
	configureMcpReconnect({ connection, logger, random: () => 1, reconnect });
	return { connection, logger };
}

describe("MCP dispose stays bounded while reconnects are running (senpi#4642)", () => {
	it("#given a reconnect stuck in a slow OAuth refresh that ignores its signal #when dispose lands #then dispose resolves within its bound and the attempt, when it finally fails, writes nothing", async () => {
		// given
		vi.useFakeTimers();
		const stuck = Promise.withResolvers<void>();
		let attempts = 0;
		const { connection, logger } = await connectionWithReconnect("stuck", async () => {
			attempts += 1;
			await stuck.promise;
		});
		const attempt = reconnectMcpNow(connection).catch((error: unknown) => error);
		await vi.waitFor(() => expect(attempts).toBe(1));
		const atDispose = readLog(logger);

		// when
		let disposed = false;
		const disposing = Promise.resolve(disposeMcpReconnect(connection)).then(() => {
			disposed = true;
		});
		await vi.advanceTimersByTimeAsync(MCP_RECONNECT_DISPOSE_WAIT_MS);
		const settledWithinBound = disposed;
		stuck.reject(new Error("token endpoint timed out"));
		await attempt;
		await disposing;
		await vi.advanceTimersByTimeAsync(60_000);

		// then
		expect(settledWithinBound).toBe(true);
		expect(attempts).toBe(1);
		expect(connection.state).not.toBe("degraded");
		expect(readLog(logger)).toBe(atDispose);
	});

	it("#given a manual reconnect overlapping one already running #when dispose lands #then it waits for both attempts, not only the latest", async () => {
		// given
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let attempts = 0;
		const { connection } = await connectionWithReconnect("overlap", async () => {
			const gate = gates[attempts];
			attempts += 1;
			await gate?.promise;
		});
		const first = reconnectMcpNow(connection).catch((error: unknown) => error);
		await vi.waitFor(() => expect(attempts).toBe(1));
		const second = reconnectMcpNow(connection).catch((error: unknown) => error);
		await vi.waitFor(() => expect(attempts).toBe(2));

		// when: the latest attempt settles first, the older one is still running
		let disposed = false;
		const disposing = Promise.resolve(disposeMcpReconnect(connection, 60_000)).then(() => {
			disposed = true;
		});
		gates[1]?.resolve();
		await second;
		await Promise.resolve();
		const settledWhileOlderRan = disposed;
		gates[0]?.resolve();
		await first;
		await disposing;

		// then
		expect(settledWhileOlderRan).toBe(false);
		expect(disposed).toBe(true);
	});

	it("#given a stale token whose refresh hangs in discovery #when the caller's signal aborts #then ensureFresh rejects at once, the token-store lock is released and nothing is written", async () => {
		// given: a stored, expired token with a refresh token; discovery only ends when its signal aborts
		const agentDir = await tempDir("refresh");
		const serverUrl = "https://mcp.example.invalid/mcp";
		const store = new McpTokenStore({ agentDir, serverName: "slow", serverUrl });
		const provider = new McpOAuthProvider({
			serverName: "slow",
			serverUrl,
			store,
			redirectUrl: "http://127.0.0.1:8123/callback",
			scopes: ["mcp"],
			clientId: "static-client",
		});
		await store.update((current) => ({
			...current,
			accessToken: "stale",
			refreshToken: "refresh",
			expiresAt: Date.now() - 1_000,
			issuer: "https://auth.example.invalid",
		}));
		const before = store.read();
		let discoveries = 0;
		const refresh = new McpRefreshManager(provider, {
			discover: (_url, signal) =>
				new Promise((_resolve, reject) => {
					discoveries += 1;
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		});
		const controller = new AbortController();
		let outcome: string | undefined;
		const fresh = refresh.ensureFresh(controller.signal).then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.name : String(error)),
		);
		void fresh.then((value) => {
			outcome = value;
		});
		await vi.waitFor(() => expect(discoveries).toBe(1));

		// when
		controller.abort();
		await vi.waitFor(() => expect(outcome).toBeDefined());

		// then: aborted, the lock is free again, and the stored credentials are untouched
		expect(outcome).toBe("AbortError");
		await expect(store.withLock(() => "free")).resolves.toBe("free");
		expect(store.read()).toEqual(before);
	});
});
