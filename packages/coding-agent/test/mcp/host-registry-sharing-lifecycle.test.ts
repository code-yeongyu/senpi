import { afterEach, describe, expect, it, vi } from "vitest";
import * as cache from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import type { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { SharedMcpLease } from "../../src/core/extensions/builtin/mcp/shared-lease.ts";
import { attach, cleanupRoots, fakePi, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

const cleanup: Array<() => Promise<void>> = [];
const registries: HostMcpRegistry[] = [];
const services: McpService[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(services.splice(0).map((s) => s.dispose("quit")));
	for (const registry of registries.splice(0)) await registry.dispose();
	vi.restoreAllMocks();
	await cleanupRoots(cleanup);
});

async function pair(overrides: Record<string, unknown> = {}) {
	const root = makeRoot("sharing-edges", cleanup);
	const fixture = await sharingHttpFixture();
	cleanup.push(() => fixture.close());
	const registry = new HostMcpRegistry();
	registries.push(registry);
	const a = new McpService({ mcpRegistry: registry });
	const b = new McpService({ mcpRegistry: registry });
	services.push(a, b);
	const config = { type: "http", url: fixture.url, auth: false, lifecycle: "eager", idleTimeoutMin: 1 };
	setConfig(root, { fx: config });
	await attach(a, root, "startup");
	await a.whenAttachSettled(10_000);
	setConfig(root, { fx: { ...config, ...overrides } });
	await attach(b, root, "startup");
	await b.whenAttachSettled(10_000);
	const ac = a.getConnection("fx");
	const bc = b.getConnection("fx");
	if (!ac || !bc) throw new Error("missing connections");
	return { a, b, ac, bc, fixture, registry, root };
}

// senpi#1921: owner policy must not become physical transport identity.
describe("shared MCP ownership boundaries", () => {
	it.each(["ECONNRESET", "ECONNREFUSED", "UND_ERR_SOCKET"])("renews once for bundled fetch cause %s", async (code) => {
		const { ac, bc, fixture } = await pair();
		if (!(ac instanceof SharedMcpLease)) throw new Error("expected shared lease");
		const recovered = Promise.all([recovery(ac), recovery(bc)]);
		ac.shared.connection.client.onerror?.(
			new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }),
		);
		await recovered;
		expect(fixture.connects).toBe(2);
		expect(await bc.client.callTool({ name: "echo", arguments: { code } })).toMatchObject({
			content: [{ text: JSON.stringify({ code }) }],
		});
	});
	it("honors any attached keep-alive owner and stops pinging when it detaches", async () => {
		vi.useFakeTimers();
		const { b, fixture } = await pair({ lifecycle: "keep-alive" });
		expect(fixture.connects).toBe(1);
		const ping = fixture.nextPing();
		await vi.advanceTimersByTimeAsync(30_000);
		await ping;
		expect(fixture.pings).toBe(1);
		await b.dispose("quit");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fixture.pings).toBe(1);
	});

	it.each(["abrupt", "graceful"] as const)(
		"reconnects once after %s transport loss and broadcasts both transitions to every owner",
		async (kind) => {
			const { ac, bc, fixture } = await pair();
			const recovered = Promise.all([recovery(ac), recovery(bc)]);
			if (kind === "abrupt") fixture.dropTransports();
			else await fixture.endStreams();
			await recovered;
			expect(fixture.connects).toBe(2);
			expect(await bc.client.callTool({ name: "echo", arguments: { recovered: true } })).toMatchObject({
				content: [{ text: '{"recovered":true}' }],
			});
		},
	);

	it("multicasts logging notifications to both session log handlers", async () => {
		const { a, b, ac, bc, fixture } = await pair();
		const initial = Promise.all([registered(a), registered(b)]);
		ac.markToolsChanged();
		bc.markToolsChanged();
		await initial;
		const changed = Promise.all([registered(a), registered(b)]);
		await fixture.log("shared-log-marker");
		await fixture.changeTools("after_log");
		await changed;
		expect(a.getLogLines("fx", 20).join("\n")).toContain("shared-log-marker");
		expect(b.getLogLines("fx", 20).join("\n")).toContain("shared-log-marker");
	});

	it("multicasts resource_updated to both session registration handlers", async () => {
		const { a, b, ac, bc, fixture } = await pair();
		const initial = Promise.all([registered(a), registered(b)]);
		ac.markToolsChanged();
		bc.markToolsChanged();
		await initial;
		const changed = Promise.all([registered(a), registered(b)]);
		await fixture.resourceUpdated();
		await changed;
		expect(fixture.connects).toBe(1);
	});

	it("declines server-initiated elicitation without an in-flight owner", async () => {
		const { a, b, fixture } = await pair();
		const input = vi.fn(async () => "must not reach UI");
		for (const s of [a, b])
			s.setMcpElicitationUiProvider(() => ({ input, select: async () => undefined, confirm: async () => true }));
		expect(await fixture.elicit()).toEqual({ action: "decline" });
		expect(input).not.toHaveBeenCalled();
	});

	it("uses the maximum attached idle timeout and never idles with an owner", async () => {
		const { a, b, fixture, registry } = await pair({ idleTimeoutMin: 2 });
		expect(fixture.connects).toBe(1);
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(180_000);
		expect(registry.size()).toBe(1);
		await a.dispose("quit");
		await b.dispose("quit");
		await vi.advanceTimersByTimeAsync(119_000);
		expect(registry.size()).toBe(1);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(registry.size()).toBe(0);
	});

	it("pins the connection until a detached owner's in-flight call settles", async () => {
		const { a, b, ac, fixture, registry } = await pair();
		const entered = fixture.holdCalls(1);
		const call = ac.client.callTool({ name: "echo", arguments: { held: true } });
		await entered;
		vi.useFakeTimers();
		await a.dispose("quit");
		await b.dispose("quit");
		await vi.advanceTimersByTimeAsync(61_000);
		expect(registry.size()).toBe(1);
		fixture.releaseCalls();
		expect(await call).toMatchObject({ content: [{ text: '{"held":true}' }] });
		await vi.advanceTimersByTimeAsync(61_000);
		expect(registry.size()).toBe(0);
	});

	it("pins non-tool requests until they settle after final detach", async () => {
		const { a, b, ac, fixture, registry } = await pair();
		const entered = fixture.holdLists();
		const list = ac.client.listTools().catch((error: unknown) => error);
		await entered;
		vi.useFakeTimers();
		await a.dispose("quit");
		await b.dispose("quit");
		await vi.advanceTimersByTimeAsync(61_000);
		expect(registry.size()).toBe(1);
		fixture.releaseLists();
		expect(await list).toMatchObject({ tools: [{ name: "echo" }] });
		await vi.advanceTimersByTimeAsync(61_000);
		expect(registry.size()).toBe(0);
	});

	it("declines elicitation with two concurrent owners rather than choosing a UI", async () => {
		const { a, b, ac, bc, fixture } = await pair();
		const input = vi.fn(async () => "must not reach UI");
		for (const s of [a, b])
			s.setMcpElicitationUiProvider(() => ({ input, select: async () => undefined, confirm: async () => true }));
		const entered = fixture.holdCalls(2);
		const calls = [ac.client.callTool({ name: "elicit" }), bc.client.callTool({ name: "elicit" })];
		await entered;
		fixture.releaseCalls();
		const results = await Promise.all(calls);
		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ content: [{ type: "text", text: '{"action":"decline"}' }] }),
			]),
		);
		expect(input).not.toHaveBeenCalled();
	});

	it("writes one catalog for the shared connect and reuses it across owners", async () => {
		const writes = vi.spyOn(cache, "writeMcpCachedServer");
		const { fixture, root } = await pair();
		expect(fixture.connects).toBe(1);
		expect(writes).toHaveBeenCalledTimes(1);
		expect((await cache.readMcpCatalogCache(root.agentDir)).servers.fx.tools.map((tool) => tool.name)).toEqual([
			"echo",
		]);
	});

	it("re-lists only the renewing owner without reconnecting or refreshing its sibling", async () => {
		const { a, b, ac, bc, fixture, root } = await pair();
		// Drain initial coalesced registration through its event, before the action.
		const initial = Promise.all([registered(a), registered(b)]);
		ac.markToolsChanged();
		bc.markToolsChanged();
		await initial;
		const ap = fakePi();
		const bp = fakePi();
		await a.attachSession(
			{ type: "session_start", reason: "reload" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			ap,
			{ agentDir: root.agentDir },
		);
		await b.attachSession(
			{ type: "session_start", reason: "reload" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			bp,
			{ agentDir: root.agentDir },
		);
		const changed = registered(a);
		const bChanged = vi.fn();
		b.onMcpRegistrationChanged(bChanged);
		fixture.setTools("owner_refresh");
		await ac.renew();
		await changed;
		expect(ap.registeredTools).toContain("mcp_fx_owner_refresh");
		expect(bp.registeredTools).not.toContain("mcp_fx_owner_refresh");
		expect(bChanged).not.toHaveBeenCalled();
		expect(bc.state).toBe("connected");
		expect(fixture.connects).toBe(1);
	});
});

function registered(service: McpService): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error("registration missing"));
		}, 5000);
		const off = service.onMcpRegistrationChanged(() => {
			clearTimeout(timer);
			off();
			resolve();
		});
	});
}

function recovery(connection: ServerConnection): Promise<void> {
	return new Promise((resolve, reject) => {
		let disconnected = false;
		const timer = setTimeout(() => {
			off();
			reject(new Error("shared reconnect missing"));
		}, 5000);
		const off = connection.onStateChange((event) => {
			if (event.state === "degraded") disconnected = true;
			if (disconnected && event.state === "connected") {
				clearTimeout(timer);
				off();
				resolve();
			}
		});
	});
}
