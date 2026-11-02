import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAuthorization, completeAuthorization } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	configureMcpReconnect,
	disposeMcpReconnect,
	getMcpReconnectDebugSnapshot,
	reconnectMcpNow,
} from "../../src/core/extensions/builtin/mcp/reconnect.ts";
import { spawnOAuthIdp } from "./fixtures/spawn-idp.ts";
import { serverConfig } from "./fixtures/reconnect.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `senpi-mcp-4642-${name}-`));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function providerFor(store: McpTokenStore, serverUrl: string): McpOAuthProvider {
	return new McpOAuthProvider({
		serverName: "fix",
		serverUrl,
		store,
		redirectUrl: "http://127.0.0.1:8123/callback",
		scopes: ["mcp"],
		clientId: "static-client",
	});
}

/** A signed-in provider against a fixture IdP that rotates refresh tokens (OAuth 2.1 public clients), due for refresh. */
async function signedInDueForRefresh() {
	const fixture = await spawnOAuthIdp(["--rotate-refresh"]);
	cleanups.push(fixture.cleanup);
	const store = new McpTokenStore({ agentDir: await tempDir("idp"), serverName: "fix", serverUrl: fixture.mcpUrl });
	const provider = providerFor(store, fixture.mcpUrl);
	const begin = await beginAuthorization(provider);
	const response = await fetch(begin.authorizationUrl as URL, { redirect: "manual" });
	const location = response.headers.get("location");
	if (location === null) throw new Error(`authorize did not redirect: ${response.status}`);
	await completeAuthorization(provider, location);
	await store.update((current) => ({ ...current, expiresAt: Date.now() + 60_000 }));
	return { fixture, store, provider };
}

const isRefreshRequest = (init: RequestInit | undefined): boolean =>
	String(init?.body ?? "").includes("grant_type=refresh_token");

describe("an aborted reconnect cancels an OAuth refresh only before its token request is sent (senpi#4642)", () => {
	it("#given a refresh waiting for the token-store lock #when its signal aborts #then the caller stops waiting and, once the lock frees, nothing is discovered or written", async () => {
		// given: another holder keeps the lock while the refresh queues for it
		const serverUrl = "https://mcp.example.invalid/mcp";
		const store = new McpTokenStore({ agentDir: await tempDir("lock"), serverName: "fix", serverUrl });
		await store.update((current) => ({
			...current,
			accessToken: "stale",
			refreshToken: "refresh",
			expiresAt: Date.now() - 1_000,
			issuer: "https://auth.example.invalid",
		}));
		const before = store.read();
		let discoveries = 0;
		const refresh = new McpRefreshManager(providerFor(store, serverUrl), {
			discover: async () => {
				discoveries += 1;
				throw new Error("discovery must not run");
			},
		});
		const holder = Promise.withResolvers<void>();
		const lockHeld = Promise.withResolvers<void>();
		const holding = store.withLock(async () => {
			lockHeld.resolve();
			await holder.promise;
		});
		await lockHeld.promise;
		const controller = new AbortController();
		const fresh = refresh.ensureFresh(controller.signal).then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.name : String(error)),
		);

		// when
		controller.abort();
		const outcome = await fresh;
		holder.resolve();
		await holding;
		await refresh.refresh().catch(() => undefined);

		// then
		expect(outcome).toBe("AbortError");
		expect(discoveries).toBe(0);
		expect(store.read()).toEqual(before);
	});

	it.each([
		["while the token request is in flight", "before-response"],
		["after the response arrived, before it is persisted", "after-response"],
	] as const)(
		"#given a refresh whose token request was sent #when dispose aborts it %s #then the caller stops waiting and the rotated tokens are still persisted",
		async (_when, gateAt) => {
			// given
			const { fixture, store, provider } = await signedInDueForRefresh();
			const before = store.read();
			const tokenHitsBefore = (await fixture.getLog()).tokenHits;
			const sent = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const fetchFn: FetchLike = async (input, init) => {
				if (!isRefreshRequest(init)) return fetch(input, init);
				sent.resolve();
				if (gateAt === "before-response") await gate.promise;
				const response = await fetch(input, init);
				if (gateAt === "after-response") await gate.promise;
				return response;
			};
			const refresh = new McpRefreshManager(provider, { fetchFn });
			const controller = new AbortController();
			const fresh = refresh.ensureFresh(controller.signal).then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.name : String(error)),
			);
			await sent.promise;

			// when
			controller.abort();
			const outcome = await fresh;
			gate.resolve();
			await refresh.refresh();

			// then: the server issued new tokens once, and the store holds them
			expect(outcome).toBe("AbortError");
			expect((await fixture.getLog()).tokenHits).toBe(tokenHitsBefore + 1);
			const after = store.read();
			expect(after?.accessToken).toBeDefined();
			expect(after?.accessToken).not.toBe(before?.accessToken);
			expect(after?.refreshToken).not.toBe(before?.refreshToken);
		},
	);
});

describe("a reconfigure hands running reconnects to the new state instead of aborting them (senpi#4642)", () => {
	it("#given a reconnect running when the same connection is configured again #when that attempt then fails #then it was never aborted, and the connection is marked degraded with a retry scheduled", async () => {
		// given
		const logger = createMcpLogger("rebind", { logDir: join(await tempDir("rebind"), "logs", "mcp") });
		const connection = new ServerConnection({ config: serverConfig(), logger, serverName: "rebind" });
		cleanups.push(async () => {
			await disposeMcpReconnect(connection);
			await connection.dispose();
		});
		const gate = Promise.withResolvers<void>();
		const signals: AbortSignal[] = [];
		const reconnect = async (signal: AbortSignal) => {
			signals.push(signal);
			await gate.promise;
			throw new Error("transport closed");
		};
		configureMcpReconnect({ connection, logger, random: () => 1, reconnect });
		const attempt = reconnectMcpNow(connection).catch((error: unknown) => error);
		await vi.waitFor(() => expect(signals).toHaveLength(1));

		// when: a second attach configures the same connection, then the running attempt fails
		configureMcpReconnect({ connection, logger, random: () => 1, reconnect });
		const abortedByReconfigure = signals[0]?.aborted;
		gate.resolve();
		await attempt;

		// then
		expect(abortedByReconfigure).toBe(false);
		expect(connection.state).toBe("degraded");
		expect(getMcpReconnectDebugSnapshot(connection).timerHasRef).not.toBeNull();
	});
});
