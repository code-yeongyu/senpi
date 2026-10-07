import { expect, it } from "vitest";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

for (const account of ["account-a", "account-b"] as const) {
	it(`only advertises the previous account's cached tools to ${account}`, async () => {
		const cleanup: Array<() => Promise<void>> = [];
		const fixture = await sharingHttpFixture();
		const first = new McpService();
		const second = new McpService();
		try {
			const root = makeRoot("2843-cached-account", cleanup);
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
			await first.attachSession({ type: "session_start", reason: "startup" }, context, capturingPi(), {
				agentDir: root.agentDir,
				env: { MCP_DEMO_ACCOUNT: "account-a" },
			});
			expect(await first.whenAttachSettled(5000)).toBe("settled");
			await first.dispose("quit");
			fixture.holdLists();
			const pi = capturingPi();
			await second.attachSession({ type: "session_start", reason: "startup" }, context, pi, {
				agentDir: root.agentDir,
				env: { MCP_DEMO_ACCOUNT: account },
			});
			expect(pi.toolDefinitions.has("mcp_fx_echo")).toBe(account === "account-a");
		} finally {
			fixture.releaseLists();
			await second.whenAttachSettled(5000);
			await first.dispose("quit");
			await second.dispose("quit");
			await fixture.close();
			await cleanupRoots(cleanup);
		}
	});
}

it("never dispatches a retained tool using the earlier account after credentials change", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const fixture = await sharingHttpFixture();
	const service = new McpService();
	try {
		const root = makeRoot("2843-live-account", cleanup);
		setConfig(root, {
			fx: {
				type: "http",
				url: fixture.url,
				auth: "bearer",
				bearerTokenEnv: "MCP_DEMO_ACCOUNT",
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
		const retained = registeredTool(pi, "mcp_fx_echo");
		env.MCP_DEMO_ACCOUNT = "account-b";
		const result: Awaited<ReturnType<typeof retained.execute>> = await Reflect.apply(retained.execute, retained, [
			"account-switch",
			{},
			undefined,
			undefined,
		]);
		expect(fixture.callAuthorizations).not.toContain("Bearer account-a");
		if (fixture.callAuthorizations.length > 0) {
			expect(fixture.callAuthorizations).toEqual(["Bearer account-b"]);
		} else {
			expect(result).toHaveProperty("details.error");
		}
	} finally {
		await service.dispose("quit");
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});

for (const account of ["account-a", "account-b"] as const) {
	it(`binds cached OAuth tools to the current opaque credentials for ${account}`, async () => {
		const cleanup: Array<() => Promise<void>> = [];
		const fixture = await sharingHttpFixture();
		const first = new McpService();
		const second = new McpService();
		try {
			const root = makeRoot("2843-oauth-account", cleanup);
			setConfig(root, {
				fx: {
					type: "http",
					url: fixture.url,
					auth: "oauth",
					lifecycle: "lazy",
					exposure: "direct",
					requestTimeoutMs: 2000,
				},
			});
			const store = new McpTokenStore({ serverName: "fx", serverUrl: fixture.url, agentDir: root.agentDir });
			await store.update(() => ({
				accessToken: "account-a",
				refreshToken: "refresh-a",
				expiresAt: Date.now() + 3_600_000,
			}));
			const context = { cwd: root.cwd, isProjectTrusted: () => true };
			await first.attachSession({ type: "session_start", reason: "startup" }, context, capturingPi(), {
				agentDir: root.agentDir,
			});
			expect(await first.whenAttachSettled(5000)).toBe("settled");
			await first.dispose("quit");
			if (account !== "account-a") {
				await store.update(() => ({
					accessToken: account,
					refreshToken: "refresh-b",
					expiresAt: Date.now() + 3_600_000,
				}));
			}
			fixture.holdLists();
			const pi = capturingPi();
			await second.attachSession({ type: "session_start", reason: "startup" }, context, pi, {
				agentDir: root.agentDir,
			});
			expect(pi.toolDefinitions.has("mcp_fx_echo")).toBe(account === "account-a");
		} finally {
			fixture.releaseLists();
			await second.whenAttachSettled(5000);
			await first.dispose("quit");
			await second.dispose("quit");
			await fixture.close();
			await cleanupRoots(cleanup);
		}
	});
}

it("replaces one account's shared lease without interrupting the other owner", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const fixture = await sharingHttpFixture();
	const registry = new HostMcpRegistry();
	const first = new McpService({ mcpRegistry: registry });
	const second = new McpService({ mcpRegistry: registry });
	try {
		const root = makeRoot("2843-shared-account", cleanup);
		setConfig(root, {
			fx: {
				type: "http",
				url: fixture.url,
				auth: "bearer",
				bearerTokenEnv: "MCP_DEMO_ACCOUNT",
				exposure: "direct",
				requestTimeoutMs: 2000,
			},
		});
		const firstEnv = { MCP_DEMO_ACCOUNT: "account-a" };
		const firstPi = capturingPi();
		const secondPi = capturingPi();
		const context = { cwd: root.cwd, isProjectTrusted: () => true };
		await first.attachSession({ type: "session_start", reason: "startup" }, context, firstPi, {
			agentDir: root.agentDir,
			env: firstEnv,
		});
		expect(await first.whenAttachSettled(5000)).toBe("settled");
		await second.attachSession({ type: "session_start", reason: "startup" }, context, secondPi, {
			agentDir: root.agentDir,
			env: { MCP_DEMO_ACCOUNT: "account-a" },
		});
		expect(await second.whenAttachSettled(5000)).toBe("settled");
		const retained = registeredTool(firstPi, "mcp_fx_echo");
		firstEnv.MCP_DEMO_ACCOUNT = "account-b";
		await Reflect.apply(retained.execute, retained, ["switched-owner", {}, undefined, undefined]);
		expect(fixture.calls).toBe(0);
		const other = registeredTool(secondPi, "mcp_fx_echo");
		const result: Awaited<ReturnType<typeof other.execute>> = await Reflect.apply(other.execute, other, [
			"unchanged-owner",
			{ value: "other-owner" },
			undefined,
			undefined,
		]);
		expect(fixture.callAuthorizations).toEqual(["Bearer account-a"]);
		expect(result.content).toContainEqual({ type: "text", text: JSON.stringify({ value: "other-owner" }) });
	} finally {
		await first.dispose("quit");
		await second.dispose("quit");
		await registry.dispose();
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});
