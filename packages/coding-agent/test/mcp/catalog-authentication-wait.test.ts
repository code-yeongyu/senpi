import { expect, it } from "vitest";
import { readMcpCatalogCache, writeMcpCachedServer } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { loadMcpConfig } from "../../src/core/extensions/builtin/mcp/config.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { refreshMcpToolsOnListChanged } from "../../src/core/extensions/builtin/mcp/service-tools-changed.ts";
import type { McpConnectionEntry } from "../../src/core/extensions/builtin/mcp/service-types.ts";
import { wrapAsync } from "../../src/core/extensions/builtin/mcp/wrap.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";
import { oauthHarness } from "../suite/regressions/2861-mcp-oauth-support.ts";

// #2843: account changes during selected-server discovery invalidate its result.
for (const shared of [false, true]) {
	it(`rejects an account switch while ${shared ? "shared" : "private"} discovery is held`, async () => {
		const cleanup: Array<() => Promise<void>> = [];
		const fixture = await sharingHttpFixture();
		const registry = new HostMcpRegistry();
		const seed = new McpService();
		const service = new McpService(shared ? { mcpRegistry: registry } : {});
		let pending: Promise<unknown> | undefined;
		try {
			const root = makeRoot("2843-account-wait", cleanup);
			setConfig(root, {
				fx: {
					type: "http",
					url: fixture.url,
					auth: "bearer",
					bearerTokenEnv: "MCP_DEMO_ACCOUNT",
					lifecycle: "lazy",
					exposure: "direct",
					requestTimeoutMs: 2000,
				},
			});
			const context = { cwd: root.cwd, isProjectTrusted: () => true };
			await seed.attachSession({ type: "session_start", reason: "startup" }, context, capturingPi(), {
				agentDir: root.agentDir,
				env: { MCP_DEMO_ACCOUNT: "account-a" },
			});
			expect(await seed.whenAttachSettled(5000)).toBe("settled");
			await seed.dispose("quit");
			const seeded = (await readMcpCatalogCache(root.agentDir)).servers.fx;
			if (seeded === undefined) throw new Error("missing seeded catalog");
			const original = { ...seeded, fetchedAt: seeded.fetchedAt - 60_000 };
			await writeMcpCachedServer(root.agentDir, "fx", original);
			const entered = fixture.holdLists();
			const env = { MCP_DEMO_ACCOUNT: "account-a" };
			const pi = capturingPi();
			await service.attachSession({ type: "session_start", reason: "startup" }, context, pi, {
				agentDir: root.agentDir,
				env,
			});
			const retained = registeredTool(pi, "mcp_fx_echo");
			pending = Reflect.apply(retained.execute, retained, ["waiting-account", {}, undefined, undefined]);
			await catalogEntered(entered);
			env.MCP_DEMO_ACCOUNT = "account-b";
			fixture.releaseLists();
			const result = await pending;
			expect(result).toHaveProperty("details.error");
			expect(fixture.calls).toBe(0);
			const cache = await readMcpCatalogCache(root.agentDir);
			expect(cache.servers.fx).toEqual(original);
		} finally {
			fixture.releaseLists();
			await pending;
			await seed.dispose("quit");
			await service.dispose("quit");
			await registry.dispose();
			await fixture.close();
			await cleanupRoots(cleanup);
		}
	});
}

// #2861: an owner retired while refresh is pending cannot renew or dispatch when that refresh returns.
for (const shared of [false, true]) {
	it(`abandons ${shared ? "shared" : "private"} readiness after retirement without failing a surviving owner`, async () => {
		const harness = await oauthHarness(shared, "lazy");
		let pending: Promise<unknown> | undefined;
		try {
			await harness.signIn();
			const owner = await harness.attach();
			const peer = shared ? await harness.attach() : undefined;
			await harness.fixture.holdRefresh();
			await harness.expire();
			pending = owner.call("retired");
			await harness.fixture.refreshEntered();
			await owner.service.dispose("quit");
			await harness.fixture.releaseRefresh();
			expect(await pending).toHaveProperty("details.error.kind", "unavailable");
			expect(
				(await harness.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
			).toHaveLength(0);
			if (peer !== undefined) {
				expect(await peer.call("survivor")).not.toHaveProperty("details.error");
				expect(peer.service.getConnection("race")?.state).toBe("connected");
			}
		} finally {
			await harness.fixture.releaseRefresh();
			await pending;
			await harness.cleanup();
		}
	});
}

it("does not cancel another owner's refresh when a selected invocation is cancelled", async () => {
	const harness = await oauthHarness(true, "lazy");
	let cancelled: Promise<unknown> | undefined;
	let surviving: Promise<unknown> | undefined;
	try {
		await harness.signIn();
		const owner = await harness.attach();
		const peer = await harness.attach();
		const before = await harness.fixture.getLog();
		await harness.fixture.holdRefresh();
		await harness.expire();
		const controller = new AbortController();
		cancelled = owner.call("cancelled", controller.signal).catch((error: unknown) => error);
		await harness.fixture.refreshEntered();
		surviving = peer.call("survivor");
		controller.abort(new Error("synthetic caller cancellation"));
		expect(await cancelled).toBeInstanceOf(Error);
		await harness.fixture.releaseRefresh();
		expect(await surviving).not.toHaveProperty("details.error");
		const after = await harness.fixture.getLog();
		expect(after.tokenHits - before.tokenHits).toBe(1);
		expect(after.requests.filter((request) => request.rpcMethod === "tools/call")).toHaveLength(1);
		expect(after.familyInvalidated).toBe(false);
	} finally {
		await harness.fixture.releaseRefresh();
		await Promise.all([cancelled, surviving]);
		await harness.cleanup();
	}
});

// #2861: a handler that has begun is never replayed under successor credentials or after cancellation.
for (const shared of [false, true]) {
	for (const action of ["replace", "cancel"] as const) {
		it(`does not replay an entered ${shared ? "shared" : "private"} call after ${action}`, async () => {
			const cleanup: Array<() => Promise<void>> = [];
			const fixture = await sharingHttpFixture();
			const registry = new HostMcpRegistry();
			const service = new McpService(shared ? { mcpRegistry: registry } : {});
			let pending: Promise<unknown> | undefined;
			try {
				const root = makeRoot("2861-entered-call", cleanup);
				setConfig(root, {
					fx: {
						type: "http",
						url: fixture.url,
						auth: "bearer",
						bearerTokenEnv: "MCP_DEMO_ACCOUNT",
						lifecycle: "lazy",
						exposure: "direct",
						requestTimeoutMs: 2000,
					},
				});
				const env = { MCP_DEMO_ACCOUNT: "account-a" };
				const pi = capturingPi();
				await service.attachSession(
					{ type: "session_start", reason: "startup" },
					{ cwd: root.cwd, isProjectTrusted: () => true },
					pi,
					{ agentDir: root.agentDir, env },
				);
				expect(await service.whenAttachSettled(5000)).toBe("settled");
				const tool = registeredTool(pi, "mcp_fx_echo");
				const entered = fixture.holdCalls(1);
				const controller = new AbortController();
				pending = Reflect.apply(tool.execute, tool, ["entered", {}, controller.signal, undefined]).catch(
					(error: unknown) => error,
				);
				await catalogEntered(entered);
				if (action === "replace") {
					env.MCP_DEMO_ACCOUNT = "account-b";
					await service.dispose("quit");
				} else {
					controller.abort(new Error("synthetic caller cancellation"));
				}
				fixture.releaseCalls();
				await pending;
				expect(fixture.calls).toBe(1);
				expect(fixture.callAuthorizations).toEqual(["Bearer account-a"]);
			} finally {
				fixture.releaseCalls();
				await pending;
				await service.dispose("quit");
				await registry.dispose();
				await fixture.close();
				await cleanupRoots(cleanup);
			}
		});
	}
}

// #2861: a rejected required list belongs to its captured owner/generation, including the error sink.
for (const shared of [false, true]) {
	for (const retired of [false, true]) {
		it(`reports required-list failure only for a live ${shared ? "shared" : "private"} catalog owner (${retired})`, async () => {
			const cleanup: Array<() => Promise<void>> = [];
			const root = makeRoot("2861-catalog-rejection", cleanup);
			const fixture = await sharingHttpFixture();
			const registry = new HostMcpRegistry();
			const service = new McpService(shared ? { mcpRegistry: registry } : {});
			let pending: Promise<void> | undefined;
			try {
				setConfig(root, { fx: { type: "http", url: fixture.url, auth: false, exposure: "direct" } });
				const pi = capturingPi();
				await service.attachSession(
					{ type: "session_start", reason: "startup" },
					{ cwd: root.cwd, isProjectTrusted: () => true },
					pi,
					{ agentDir: root.agentDir },
				);
				expect(await service.whenAttachSettled(5000)).toBe("settled");
				const connection = service.getConnection("fx");
				const config = loadMcpConfig({ cwd: root.cwd, agentDir: root.agentDir, projectTrusted: true });
				const cached = (await readMcpCatalogCache(root.agentDir)).servers.fx;
				if (connection === undefined || cached === undefined) throw new Error("missing actual catalog owner");
				const entry: McpConnectionEntry = {
					connection,
					agentDir: root.agentDir,
					name: "fx",
					key: "held-notification",
					configHash: cached.configHash,
					createdAtMs: Date.now(),
					counters: { callCount: 0, errorCount: 0, reconnectCount: 0, totalLatencyMs: 0 },
					logger: createMcpLogger("fx", { logDir: root.agentDir }),
					cachedCatalog: cached,
					cacheRefreshedAfterConnect: true,
					catalogGeneration: connection.generation,
					isCurrent: () => service.getConnection("fx") === connection,
				};
				const errors: string[] = [];
				const entered = fixture.holdLists();
				pending = wrapAsync(
					"catalog-notification",
					() => refreshMcpToolsOnListChanged(entry, () => [], config, false),
					{
						logger: {
							error: (_message, data) => {
								errors.push(JSON.stringify(data));
							},
						},
					},
				)();
				await catalogEntered(entered);
				if (retired) await service.dispose("quit");
				fixture.releaseLists(new Error("synthetic required-list failure"));
				await pending;
				if (retired) expect(errors).toEqual([]);
				else expect(errors.join("\n")).toContain("synthetic required-list failure");
				expect(entry.cachedCatalog).toEqual(cached);
				expect((await readMcpCatalogCache(root.agentDir)).servers.fx).toEqual(cached);
				expect(entry.knownToolNames).toBeUndefined();
			} finally {
				fixture.releaseLists();
				await pending;
				await service.dispose("quit");
				await registry.dispose();
				await fixture.close();
				await cleanupRoots(cleanup);
			}
		});
	}
}

function catalogEntered(entered: Promise<void>): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = AbortSignal.timeout(5000);
		deadline.addEventListener("abort", () => reject(deadline.reason), { once: true });
		void entered.then(resolve, reject);
	});
}
