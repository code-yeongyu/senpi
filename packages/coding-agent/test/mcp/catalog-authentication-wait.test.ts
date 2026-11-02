import { expect, it } from "vitest";
import { readMcpCatalogCache, writeMcpCachedServer } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

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

function catalogEntered(entered: Promise<void>): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = AbortSignal.timeout(5000);
		deadline.addEventListener("abort", () => reject(deadline.reason), { once: true });
		void entered.then(resolve, reject);
	});
}
