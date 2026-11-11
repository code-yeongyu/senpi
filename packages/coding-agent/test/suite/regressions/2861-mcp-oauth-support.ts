import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuthCommandDeps,
	runAuthComplete,
	runAuthStart,
} from "../../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import type { McpOAuthProvider } from "../../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import type { McpServerConfig } from "../../../src/core/extensions/builtin/mcp/config-schema.ts";
import { HostMcpRegistry } from "../../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool } from "../../mcp/fixtures/register-call.ts";
import { spawnOAuthIdp } from "../../mcp/fixtures/spawn-idp.ts";

export async function oauthHarness(
	shared: boolean,
	lifecycle: "lazy" | "keep-alive",
	args: string[] = [],
	resource?: string,
) {
	const dir = await mkdtemp(join(tmpdir(), "mcp-grant-"));
	const fixture = await spawnOAuthIdp(["--rotate-refresh", ...args]);
	const serverUrl = new URL(fixture.mcpUrl);
	if (resource !== undefined) serverUrl.searchParams.set("resource", resource);
	const registry = new HostMcpRegistry();
	const services: McpService[] = [];
	const config: McpServerConfig = {
		type: "http",
		url: serverUrl.href,
		args: [],
		auth: "oauth",
		oauth: { scopes: ["mcp", "offline_access"] },
		enabled: true,
		lifecycle,
		connectTimeoutMs: 4000,
		requestTimeoutMs: 4000,
		startupTimeoutMs: 250,
		idleTimeoutMin: 10,
		exposure: "direct",
		logLevel: "info",
	};
	const deps: AuthCommandDeps = {
		serverName: "race",
		config,
		agentDir: dir,
		hasUI: false,
		notify: () => {},
		openBrowser: () => {},
		onReconnect: () => Promise.resolve(),
		pending: new Map<string, McpOAuthProvider>(),
	};
	const store = new McpTokenStore({ agentDir: dir, serverName: "race", serverUrl: serverUrl.href });
	let signIns = 0;
	const signIn = async () => {
		deps.callbackUrl = `http://127.0.0.1:0/callback-${signIns++}`;
		const url = await runAuthStart(deps);
		const response = await fetch(url, { redirect: "manual" });
		const redirect = response.headers.get("location");
		if (redirect === null) throw new Error("fixture did not authorize");
		await runAuthComplete(deps, redirect);
	};
	const attach = async () => {
		const service = new McpService(shared ? { mcpRegistry: registry } : {});
		services.push(service);
		const pi = capturingPi();
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: dir, isProjectTrusted: () => true },
			pi,
			{ agentDir: dir },
		);
		if ((await service.whenAttachSettled()) !== "settled") throw new Error("fixture attach did not settle");
		const tool = registeredTool(pi, "mcp_race_tool_1");
		const call = (value: string, signal?: AbortSignal): ReturnType<typeof tool.execute> =>
			Reflect.apply(tool.execute, tool, [`call-${value}`, { value }, signal, undefined]);
		return { service, pi, tool, call };
	};
	await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { race: config } }));
	return {
		dir,
		fixture,
		store,
		config,
		signIn,
		attach,
		expire: () => store.update((record) => ({ ...record, expiresAt: Date.now() + 60_000 })),
		cleanup: async () => {
			for (const service of services) await service.dispose("quit");
			await registry.dispose();
			await fixture.cleanup();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
