import { expect, it } from "vitest";
import { type AuthCommandDeps, runAuthComplete, runAuthStart } from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import type { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool, textContent } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

for (const shared of [false, true]) {
	it(`keeps an invocation usable after refreshing its OAuth grant (${shared ? "shared" : "private"})`, async () => {
		const cleanup: Array<() => Promise<void>> = [];
		const registry = new HostMcpRegistry();
		const service = new McpService(shared ? { mcpRegistry: registry } : {});
		const fixture = await spawnOAuthIdp(["--rotate-refresh"]);
		try {
			const root = makeRoot("2843-service-refresh", cleanup);
			const config: McpServerConfig = {
				args: [], type: "http", url: fixture.mcpUrl, auth: "oauth", enabled: true,
				lifecycle: "eager", connectTimeoutMs: 4000, requestTimeoutMs: 4000,
				startupTimeoutMs: 5000, idleTimeoutMin: 10, exposure: "direct", logLevel: "info",
			};
			setConfig(root, { fix: config });
			const deps: AuthCommandDeps = {
				agentDir: root.agentDir, serverName: "fix", config, hasUI: true,
				notify: () => {}, openBrowser: () => {}, onReconnect: async () => {},
				pending: new Map<string, McpOAuthProvider>(),
			};
			const authorize = await runAuthStart(deps);
			const response = await fetch(authorize, { redirect: "manual" });
			const redirect = response.headers.get("location");
			if (redirect === null) throw new Error("Fixture did not return an authorization redirect");
			await runAuthComplete(deps, redirect);
			const store = new McpTokenStore({
				agentDir: root.agentDir, serverName: "fix", serverUrl: fixture.mcpUrl,
			});
			await store.update(current => ({ ...current, expiresAt: Date.now() + 3_600_000 }));
			const pi = capturingPi();
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				pi, { agentDir: root.agentDir },
			);
			expect(await service.whenAttachSettled(10_000)).toBe("settled");
			const retained = registeredTool(pi, "mcp_fix_tool_1");
			const before = await Reflect.apply(retained.execute, retained, ["before", { value: "before" }, undefined, undefined]);
			expect(textContent(before)).toBe("fixture tool_1 value=before mode=alpha");
			const tokenHits = (await fixture.getLog()).tokenHits;
			await store.update(current => ({ ...current, expiresAt: Date.now() + 60_000 }));

			const result = await Reflect.apply(retained.execute, retained, ["refresh", { value: "after" }, undefined, undefined]);

			const log = await fixture.getLog();
			expect(log.tokenHits - tokenHits).toBe(1);
			expect(log.familyInvalidated).toBe(false);
			expect(result).not.toHaveProperty("details.error");
			expect(textContent(result)).toBe("fixture tool_1 value=after mode=alpha");
		} finally {
			await service.dispose("quit");
			await registry.dispose();
			await fixture.cleanup();
			await cleanupRoots(cleanup);
		}
	});
}
