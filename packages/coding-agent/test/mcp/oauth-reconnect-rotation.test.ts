/**
 * senpi#6538: a manual /mcp reconnect on an OAuth server whose grant was rotated away always names the way back
 * (needs_auth with /mcp auth-start guidance); it never resolves quietly or reports a bare Unauthorized, whichever
 * holder of the sign-in meets the rotation first.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthComplete, runAuthStart } from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { resolveServerAuth } from "../../src/core/extensions/builtin/mcp/auth/context.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { bounded } from "./fixtures/gated-http-server.ts";
import { capturingPi } from "./fixtures/register-call.ts";
import {
	agentDir,
	cleanups,
	followAuthorize,
	idp,
	makeHarness,
	poisonRefreshToken,
	writeMcpConfig,
} from "./fixtures/oauth-headless-harness.ts";

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe("manual reconnect after a grant rotation (senpi#6538)", () => {
	// senpi#6538: the refresh token is part of the grant identity, so rotating it makes the connection's credentials
	// stale and the next background check re-keys the server. Under load that re-key landed while a manual reconnect
	// was still refreshing on the connection it retired, and the reconnect resolved quietly.
	it("surfaces auth-start guidance on manual reconnect when a credentials re-key lands mid-reconnect", async () => {
		// Given: a connected server whose refresh token was rotated away, and every token-store lock held at a gate
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await writeMcpConfig(dir, harness.deps.config);
		const service = new McpService();
		cleanups.push(() => service.dispose("quit"));
		const session = { cwd: dir, isProjectTrusted: () => true };
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		expect(service.getConnection("fix")?.state).toBe("connected");
		await poisonRefreshToken(harness);
		const released = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const withLock = McpTokenStore.prototype.withLock;
		const gate = vi.spyOn(McpTokenStore.prototype, "withLock").mockImplementation(async function (
			this: McpTokenStore,
			fn,
		) {
			reached.resolve();
			await released.promise;
			return withLock.call(this, fn);
		});
		cleanups.push(async () => gate.mockRestore());

		// When: the manual reconnect starts refreshing, another session's start re-keys the server, then the refresh runs
		const reconnect = service.reconnectServer("fix");
		const outcome = reconnect.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await reached.promise;
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		released.resolve();

		// Then: the reconnect names the way back instead of resolving quietly
		expect(await outcome).toMatch(/\/mcp auth-start fix/);
		expect(service.getServerSnapshots()).toMatchObject([
			{ lastError: expect.stringMatching(/\/mcp auth-start fix/), lifecycleState: "needs_auth", name: "fix" },
		]);
	});

	// senpi#6538: under load a background refresh (the attach's catalog refresh) can meet the rotated refresh token
	// first, get invalid_grant and clear the saved sign-in before the manual reconnect reads it.
	it("surfaces auth-start guidance on manual reconnect when another refresh already cleared the rotated credentials", async () => {
		// Given: a connected server whose refresh token was rotated away, and another holder of the same sign-in that
		// refreshes first
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await writeMcpConfig(dir, harness.deps.config);
		const service = new McpService();
		cleanups.push(() => service.dispose("quit"));
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: dir, isProjectTrusted: () => true },
			capturingPi(),
			{ agentDir: dir },
		);
		await service.whenAttachSettled();
		expect(service.getConnection("fix")?.state).toBe("connected");
		await poisonRefreshToken(harness);
		const other = resolveServerAuth({ agentDir: dir, config: harness.deps.config, serverName: "fix" });
		await expect(other.refresh?.ensureFresh()).rejects.toThrow(/invalid_grant/);
		expect(harness.store.read()).toBeUndefined();

		// When/Then: the manual reconnect still names the way back instead of resolving quietly
		await expect(service.reconnectServer("fix")).rejects.toThrow(/\/mcp auth-start fix/);
		expect(service.getServerSnapshots()).toMatchObject([
			{ lastError: expect.stringMatching(/\/mcp auth-start fix/), lifecycleState: "needs_auth", name: "fix" },
		]);
	});

	// senpi#6538 (review LOW on #7498): a re-key that lands while the manual reconnect is already running retires the
	// connection the reconnect acts on; that connection is disabled, its reconnect returns quietly, and the caller was
	// told nothing. The reconnect must act on the connection that is current and surface its needs_auth.
	// senpi#7648 (audit LOW 1, the up-front re-key): the grant is rotated before the reconnect starts, so only the
	// up-front re-key of the stale connection can catch it. Without that path the stale connection is the one the
	// reconnect refreshes, getConnection hides it, and this case fails at its `expect(running).toBeDefined()` setup step.
	it("surfaces auth-start guidance when the re-key retires the connection during the manual reconnect", async () => {
		// Given: a connected server whose refresh token was rotated away, and every token-store lock held at a gate
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await writeMcpConfig(dir, harness.deps.config);
		const service = new McpService();
		cleanups.push(() => service.dispose("quit"));
		const session = { cwd: dir, isProjectTrusted: () => true };
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		expect(service.getConnection("fix")?.state).toBe("connected");
		await poisonRefreshToken(harness);
		const released = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const withLock = McpTokenStore.prototype.withLock;
		const gate = vi.spyOn(McpTokenStore.prototype, "withLock").mockImplementation(async function (
			this: McpTokenStore,
			fn,
		) {
			reached.resolve();
			await released.promise;
			return withLock.call(this, fn);
		});
		cleanups.push(async () => gate.mockRestore());

		// When: the reconnect (already past its own pre-step re-key) is inside its refresh on the current connection, the
		// grant is rotated again in the store, and a second re-key retires that connection before the refresh runs
		const reconnect = service.reconnectServer("fix");
		const outcome = reconnect.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await reached.promise;
		gate.mockRestore();
		const running = service.getConnection("fix");
		expect(running).toBeDefined();
		const retired = new Promise<void>((resolve) => {
			const unsubscribe = running?.onStateChange((event) => {
				if (event.state !== "disabled") return;
				unsubscribe?.();
				resolve();
			});
		});
		await harness.store.update((current) => ({ ...current, refreshToken: "RT_ROTATED_AGAIN" }));
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		await bounded(retired, "the retired connection to reach disabled");
		released.resolve();

		// Then: the reconnect names the way back instead of resolving quietly
		expect(await outcome).toMatch(/\/mcp auth-start fix/);
	});
	// senpi#7648 (audit LOW 1, the post-reconnect follow): credentials are current when the manual reconnect starts, so
	// the up-front re-key has nothing to do. The grant rotates only while the reconnect is inside its refresh, another
	// session's start re-keys and retires the connection, and that connection's reconnect returns quietly. Only the
	// follow, which reconnects the connection that is current, can name the way back.
	it("surfaces auth-start guidance when the grant rotates only after the manual reconnect has started", async () => {
		// Given: a connected server with a current grant, and every token-store lock held at a gate
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await writeMcpConfig(dir, harness.deps.config);
		const service = new McpService();
		cleanups.push(() => service.dispose("quit"));
		const session = { cwd: dir, isProjectTrusted: () => true };
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		const retiring = service.getConnection("fix");
		expect(retiring?.state).toBe("connected");
		const retired = new Promise<void>((resolve) => {
			const unsubscribe = retiring?.onStateChange((event) => {
				if (event.state !== "disabled") return;
				unsubscribe?.();
				resolve();
			});
		});
		// The access token nears expiry, so the reconnect refreshes; the grant (its refresh token) is unchanged, so the
		// credentials are still current when the reconnect starts.
		await harness.store.update((current) => ({ ...current, expiresAt: Date.now() + 60_000 }));
		expect(service.getConnection("fix")).toBe(retiring);
		const released = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const withLock = McpTokenStore.prototype.withLock;
		const gate = vi.spyOn(McpTokenStore.prototype, "withLock").mockImplementation(async function (
			this: McpTokenStore,
			fn,
		) {
			reached.resolve();
			await released.promise;
			return withLock.call(this, fn);
		});
		cleanups.push(async () => gate.mockRestore());

		// When: the reconnect starts on current credentials; inside its refresh the grant is rotated away and another
		// session's start re-keys the server, retiring the connection before the refresh runs
		const reconnect = service.reconnectServer("fix");
		const outcome = reconnect.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await reached.promise;
		gate.mockRestore();
		await harness.store.update((current) => ({ ...current, refreshToken: "RT_UNKNOWN" }));
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		await bounded(retired, "the retired connection to reach disabled");
		released.resolve();

		// Then: the reconnect names the way back instead of resolving quietly
		expect(await outcome).toMatch(/\/mcp auth-start fix/);
	});
	// senpi#7648 (audit LOW 2): a manual reconnect follows a bounded number of back-to-back credential re-keys. When the
	// grant keeps rotating past that bound, the reconnect must say so instead of acting on a connection whose startup
	// has not settled (or that has been retired) and resolving quietly.
	it("reports a reconnect that keeps meeting credential re-keys instead of resolving quietly", async () => {
		// Given: a connected server whose grant rotates again every time the token store is locked
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await writeMcpConfig(dir, harness.deps.config);
		const service = new McpService();
		cleanups.push(() => service.dispose("quit"));
		const session = { cwd: dir, isProjectTrusted: () => true };
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		expect(service.getConnection("fix")?.state).toBe("connected");
		await poisonRefreshToken(harness);
		const signedIn = harness.store.read();
		expect(signedIn).toBeDefined();
		let churning = true;
		let rotation = 0;
		const withLock = McpTokenStore.prototype.withLock;
		const churn = vi.spyOn(McpTokenStore.prototype, "withLock").mockImplementation(async function (
			this: McpTokenStore,
			fn,
		) {
			// While churning, every refresh finds a freshly rotated grant and another session's start re-keys the server,
			// so each connection the reconnect follows is retired by the next re-key.
			return withLock.call(this, async () => {
				if (churning && signedIn !== undefined) {
					rotation += 1;
					this.writeUnlocked({ ...signedIn, refreshToken: `RT_CHURN_${rotation}` });
					void service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
						agentDir: dir,
					});
				}
				return await fn();
			});
		});
		cleanups.push(async () => churn.mockRestore());

		// When: the manual reconnect runs while the re-keys keep landing
		const outcome = await service.reconnectServer("fix").then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		churning = false;

		// Then: it reports the churn and names the way back, instead of resolving quietly or acting on a moving target
		expect(rotation).toBeGreaterThanOrEqual(3);
		expect(outcome).toMatch(/kept re-keying[\s\S]*\/mcp reconnect fix/);
	});
	// senpi#7650 review LOW 1: a manual reconnect that follows a re-keyed connection reconnects it once, and a re-key that
	// lands during that final reconnect retires it too; that reconnect then returns quietly. It must follow the
	// connection that is current again and surface its state.
	it("surfaces auth-start guidance when a re-key lands during the reconnect of a re-keyed connection", async () => {
		// Given: a connected server whose grant identity changes before the reconnect (a valid token, so the re-keyed
		// connection connects), and a gate on the first renew of any connection other than the original
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await writeMcpConfig(dir, harness.deps.config);
		const service = new McpService();
		cleanups.push(() => service.dispose("quit"));
		const session = { cwd: dir, isProjectTrusted: () => true };
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		const original = service.getConnection("fix");
		expect(original?.state).toBe("connected");
		await harness.store.update((current) => ({
			...current,
			expiresAt: Date.now() + 3_600_000,
			refreshToken: "RT_SWAPPED",
		}));
		const released = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<ServerConnection>();
		const renew = ServerConnection.prototype.renew;
		const gate = vi.spyOn(ServerConnection.prototype, "renew").mockImplementation(async function (
			this: ServerConnection,
		) {
			if (this !== original) {
				reached.resolve(this);
				await released.promise;
			}
			return renew.call(this);
		});
		cleanups.push(async () => gate.mockRestore());

		// When: the reconnect re-keys up front and reconnects the re-keyed connection; during that reconnect the grant is
		// rotated away and another session's start re-keys the server again, retiring the connection being reconnected
		const outcome = service.reconnectServer("fix").then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		const reconnecting = await bounded(reached.promise, "the reconnect of the re-keyed connection");
		gate.mockRestore();
		const retired = new Promise<void>((resolve) => {
			const unsubscribe = reconnecting.onStateChange((event) => {
				if (event.state !== "disabled") return;
				unsubscribe();
				resolve();
			});
		});
		await poisonRefreshToken(harness);
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		await bounded(retired, "the reconnecting connection to reach disabled");
		released.resolve();

		// Then: the reconnect names the way back instead of resolving quietly
		expect(await outcome).toMatch(/\/mcp auth-start fix/);
	});
	// senpi#7653 (part 2): a manual reconnect that follows a re-keyed connection must not resolve quietly when the
	// server is removed from the config while it reconnects; the caller has to learn that nothing is left to reconnect.
	it("reports a server removed from the config while the manual reconnect runs", async () => {
		// Given: a connected server whose grant identity changes before the reconnect, and a gate on the first renew of
		// any connection other than the original
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await writeMcpConfig(dir, harness.deps.config);
		const service = new McpService();
		cleanups.push(() => service.dispose("quit"));
		const session = { cwd: dir, isProjectTrusted: () => true };
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		const original = service.getConnection("fix");
		expect(original?.state).toBe("connected");
		await harness.store.update((current) => ({
			...current,
			expiresAt: Date.now() + 3_600_000,
			refreshToken: "RT_SWAPPED",
		}));
		const released = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<ServerConnection>();
		const renew = ServerConnection.prototype.renew;
		const gate = vi.spyOn(ServerConnection.prototype, "renew").mockImplementation(async function (
			this: ServerConnection,
		) {
			if (this !== original) {
				reached.resolve(this);
				await released.promise;
			}
			return renew.call(this);
		});
		cleanups.push(async () => gate.mockRestore());

		// When: while the re-keyed connection reconnects, the server is removed from the config and a session re-attaches
		const outcome = service.reconnectServer("fix").then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		const reconnecting = await bounded(reached.promise, "the reconnect of the re-keyed connection");
		gate.mockRestore();
		const retired = new Promise<void>((resolve) => {
			const unsubscribe = reconnecting.onStateChange((event) => {
				if (event.state !== "disabled") return;
				unsubscribe();
				resolve();
			});
		});
		await writeFile(join(dir, "mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		await service.attachSession({ type: "session_start", reason: "startup" }, session, capturingPi(), {
			agentDir: dir,
		});
		await service.whenAttachSettled();
		expect(service.getConnection("fix")).toBeUndefined();
		await bounded(retired, "the reconnecting connection to reach disabled");
		released.resolve();

		// Then: the reconnect says the server is no longer configured instead of resolving quietly or naming a retired state
		expect(await outcome).toMatch(/fix is no longer configured/);
	});
});
