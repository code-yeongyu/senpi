/**
 * senpi#6538: a manual /mcp reconnect on an OAuth server whose grant was rotated away always names the way back
 * (needs_auth with /mcp auth-start guidance); it never resolves quietly or reports a bare Unauthorized, whichever
 * holder of the sign-in meets the rotation first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthComplete, runAuthStart } from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { resolveServerAuth } from "../../src/core/extensions/builtin/mcp/auth/context.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
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
		await retired;
		released.resolve();

		// Then: the reconnect names the way back instead of resolving quietly
		expect(await outcome).toMatch(/\/mcp auth-start fix/);
	});
});
