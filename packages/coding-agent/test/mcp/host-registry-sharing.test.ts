import { afterEach, describe, expect, it, vi } from "vitest";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import type { FakePi } from "./fixtures/service-lifecycle.ts";
import { cleanupRoots, fakePi, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

const cleanup: Array<() => Promise<void>> = [];
const services: McpService[] = [];
const registries: HostMcpRegistry[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(services.splice(0).map((s) => s.dispose("quit")));
	for (const registry of registries.splice(0)) {
		if ("dispose" in registry && typeof registry.dispose === "function") await registry.dispose();
	}
	await cleanupRoots(cleanup);
});

async function pair(server?: Record<string, unknown>) {
	const root = makeRoot("sharing", cleanup);
	const fixture = await sharingHttpFixture();
	cleanup.push(() => fixture.close());
	setConfig(root, {
		fx: { type: "http", url: fixture.url, auth: false, lifecycle: "eager", idleTimeoutMin: 1, ...server },
	});
	const registry = new HostMcpRegistry();
	registries.push(registry);
	const a = new McpService({ mcpRegistry: registry });
	const b = new McpService({ mcpRegistry: registry });
	services.push(a, b);
	const ap = fakePi();
	const bp = fakePi();
	for (const [service, pi] of [
		[a, ap],
		[b, bp],
	] as const) {
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir },
		);
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
	}
	const ac = a.getConnection("fx");
	const bc = b.getConnection("fx");
	if (!ac || !bc) throw new Error("missing connections");
	return { a, b, ac, bc, ap, bp, registry, fixture, root };
}

function registration(service: McpService, pi: FakePi, name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`missing registered tool ${name}`));
		}, 3000);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			if (!pi.registeredTools.includes(name)) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

// senpi#1921: exercise real HTTP transports and per-session services, not connect mocks.
describe("in-process host MCP sharing", () => {
	it("connects one HTTP transport for two in-process session services", async () => {
		const { fixture } = await pair();
		expect(fixture.connects).toBe(1);
	});

	it("keeps B callable and the one transport alive when A closes", async () => {
		const { a, bc, fixture } = await pair();
		await a.dispose("quit");
		expect(bc.state).toBe("connected");
		expect(await bc.client.callTool({ name: "echo", arguments: { value: "B survives" } })).toMatchObject({
			content: [{ text: '{"value":"B survives"}' }],
		});
		expect(fixture.connects).toBe(1);
	});

	it("arms one idle expiry only after both owners close", async () => {
		const { a, b, registry } = await pair();
		vi.useFakeTimers();
		const closingA = a.dispose("quit");
		await vi.advanceTimersByTimeAsync(500);
		await closingA;
		const closingB = b.dispose("quit");
		await vi.advanceTimersByTimeAsync(500);
		await closingB;
		expect(registry.size()).toBe(1);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(registry.size()).toBe(1);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(registry.size()).toBe(0);
	});

	it("re-registers changed tools in both sessions from one list_changed", async () => {
		const { a, b, ap, bp, fixture } = await pair();
		const changed = Promise.all([registration(a, ap, "mcp_fx_changed"), registration(b, bp, "mcp_fx_changed")]);
		await fixture.changeTools("changed");
		await changed;
		expect(ap.registeredTools).toContain("mcp_fx_changed");
		expect(bp.registeredTools).toContain("mcp_fx_changed");
	});

	it("routes elicitation during A callTool to A UI and never B UI", async () => {
		const { a, b, ac, fixture } = await pair();
		const aInput = vi.fn(async () => "from A");
		const bInput = vi.fn(async () => "from B");
		a.setMcpElicitationUiProvider(() => ({
			input: aInput,
			select: async () => undefined,
			confirm: async () => true,
		}));
		b.setMcpElicitationUiProvider(() => ({
			input: bInput,
			select: async () => undefined,
			confirm: async () => true,
		}));
		expect(await ac.client.callTool({ name: "elicit" })).toMatchObject({
			content: [{ text: '{"action":"accept","content":{"value":"from A"}}' }],
		});
		expect(aInput).toHaveBeenCalledTimes(1);
		expect(bInput).not.toHaveBeenCalled();
		expect(fixture.connects).toBe(1);
	});

	it("keeps cwd-derived stdio environments on separate connections", async () => {
		const { ac, bc } = await pair({ ...stdioServer(["--tools", "1"]), env: { PROJECT_CWD: process.cwd() } });
		expect(ac.getRootPid()).not.toBe(bc.getRootPid());
		expect(ac.getRootPid()).not.toBeNull();
	});

	it("never shares ast-grep-shaped configurations", async () => {
		const { ac, bc } = await pair({
			...stdioServer(["--tools", "1"]),
			env: { OMO_AST_GREP_PROJECT_CWD: process.cwd() },
		});
		expect(ac.getRootPid()).not.toBe(bc.getRootPid());
		expect(ac.getRootPid()).not.toBeNull();
	});
});
