import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthCommandDeps } from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import {
	runAuth,
	runAuthComplete,
	runAuthStart,
	runLogout,
} from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { resolveServerAuth } from "../../src/core/extensions/builtin/mcp/auth/context.ts";
import type { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import type { McpToolCatalogEntry } from "../../src/core/extensions/builtin/mcp/catalog.ts";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { buildMcpToolDefinitions } from "../../src/core/extensions/builtin/mcp/expose/register.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { registerMcpServiceDirectTools } from "../../src/core/extensions/builtin/mcp/service-register.ts";
import type { McpConnectionEntry } from "../../src/core/extensions/builtin/mcp/service-types.ts";
import { connectAndRefreshMcpCatalog } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import { capturingPi, registeredTool, testContext, textContent } from "./fixtures/register-call.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function idp(args: string[] = []): Promise<IdpFixture> {
	const fixture = await spawnOAuthIdp(args);
	cleanups.push(fixture.cleanup);
	return fixture;
}

async function agentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-headless-"));
	cleanups.push(() => rm(dir, { force: true, recursive: true }));
	return dir;
}

interface Harness {
	deps: AuthCommandDeps;
	notes: { message: string; type: string }[];
	browsered: URL[];
	store: McpTokenStore;
}

function makeHarness(
	dir: string,
	mcpUrl: string,
	overrides: Partial<McpServerConfig> & { hasUI?: boolean } = {},
): Harness {
	const notes: { message: string; type: string }[] = [];
	const browsered: URL[] = [];
	const config: McpServerConfig = {
		type: "http",
		url: mcpUrl,
		args: [],
		enabled: true,
		lifecycle: "lazy",
		connectTimeoutMs: 4000,
		requestTimeoutMs: 4000,
		idleTimeoutMin: 10,
		exposure: "auto",
		logLevel: "info",
		...overrides,
	};
	const deps: AuthCommandDeps = {
		serverName: "fix",
		config,
		agentDir: dir,
		hasUI: overrides.hasUI ?? true,
		notify: (message, type = "info") => notes.push({ message, type }),
		openBrowser: (url) => {
			browsered.push(url);
		},
		onReconnect: () => Promise.resolve(),
		pending: new Map<string, McpOAuthProvider>(),
	};
	return { deps, notes, browsered, store: new McpTokenStore({ agentDir: dir, serverName: "fix", serverUrl: mcpUrl }) };
}

async function followAuthorize(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (location === null) throw new Error(`no redirect: ${response.status}`);
	return location;
}

async function redeemCodeDirectly(
	baseUrl: string,
	resource: string,
	redirect: string,
	verifier: string,
): Promise<void> {
	const url = new URL(redirect);
	const code = url.searchParams.get("code");
	if (code === null) throw new Error("expected authorization code");
	const response = await fetch(`${baseUrl}/token`, {
		body: new URLSearchParams({
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			resource,
		}),
		method: "POST",
	});
	if (!response.ok) throw new Error(`direct redemption failed: ${response.status}`);
}

async function poisonRefreshToken(harness: Harness): Promise<void> {
	await harness.store.update((current) => ({
		...current,
		expiresAt: Date.now() + 60_000,
		refreshToken: "RT_UNKNOWN",
	}));
}

async function writeMcpConfig(dir: string, config: McpServerConfig): Promise<void> {
	await writeFile(join(dir, "mcp.json"), `${JSON.stringify({ mcpServers: { fix: config } }, null, 2)}\n`);
}

describe("headless oauth flows", () => {
	it("auth-start prints an authorize URL with S256 + resource; auth-complete stores tokens", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const authUrl = await runAuthStart(harness.deps);
		const parsed = new URL(authUrl);
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("resource")).toContain("/mcp");

		const redirect = await followAuthorize(authUrl);
		await runAuthComplete(harness.deps, redirect);
		expect(harness.store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
	});

	it("rejects auth-complete when the code verifier no longer matches (continuity enforced)", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const authUrl = await runAuthStart(harness.deps);
		const redirect = await followAuthorize(authUrl);
		// Tamper the stored PKCE verifier: exchange must fail.
		await harness.store.update((current) => ({ ...current, codeVerifier: "tampered-verifier" }));
		await expect(runAuthComplete(harness.deps, redirect)).rejects.toThrow();
		expect(harness.store.read()?.accessToken).toBeUndefined();
	});

	it("gives an actionable error for a malformed pasted redirect URL", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		await runAuthStart(harness.deps);
		await expect(runAuthComplete(harness.deps, "not-a-url")).rejects.toMatchObject({ name: "OAuthFlowError" });
	});

	it("gives retry guidance for a one-use authorization code without writing an access token", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const authUrl = await runAuthStart(harness.deps);
		const redirect = await followAuthorize(authUrl);
		const codeVerifier = harness.store.read()?.codeVerifier;
		if (codeVerifier === undefined) throw new Error("expected stored PKCE verifier");
		await redeemCodeDirectly(fixture.baseUrl, fixture.mcpUrl, redirect, codeVerifier);

		await expect(runAuthComplete(harness.deps, redirect)).rejects.toThrow(/restart.*\/mcp auth-start fix/i);
		expect(harness.store.read()?.accessToken).toBeUndefined();
	});

	it("client_credentials grant stores a token without any listener", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl, {
			oauth: { flow: "client_credentials", clientId: "m2m-client" },
		});
		await runAuth(harness.deps);
		expect(harness.store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
		expect(harness.browsered).toHaveLength(0);
		expect(lastNote(harness.notes)?.message).toContain("client_credentials");
	});

	it("logout clears credentials so the next use needs auth again", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		expect(harness.store.read()?.accessToken).toBeDefined();
		await runLogout(harness.deps);
		expect(harness.store.read()).toBeUndefined();
	});

	it("fails fast in non-UI mode with a headless hint and no browser attempt", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl, { hasUI: false });
		await runAuth(harness.deps);
		const last = lastNote(harness.notes);
		expect(last?.type).toBe("error");
		expect(last?.message).toContain("/mcp auth-start");
		expect(harness.browsered).toHaveLength(0);
	});

	it("reports the headless auth-start flow when an auth-required tool is called without UI", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const config = makeHarness(dir, fixture.mcpUrl, { hasUI: false }).deps.config;
		const authPlan = resolveServerAuth({ agentDir: dir, config, serverName: "fix" });
		const connection = new ServerConnection({
			authProvider: authPlan.provider,
			config,
			logger: createMcpLogger("fix"),
			serverName: "fix",
		});
		cleanups.push(() => connection.dispose());
		const entry: McpToolCatalogEntry = {
			connection,
			requestTimeoutMs: config.requestTimeoutMs,
			schema: { type: "object" },
			server: "fix",
			tool: "secure_tool",
		};
		const [tool] = buildMcpToolDefinitions([entry]);
		if (tool === undefined) throw new Error("expected MCP tool definition");

		await expect(tool.execute("tc-auth", {}, undefined, undefined, testContext())).rejects.toThrow(
			/\/mcp auth-start fix/,
		);
	});

	it("reports the headless auth-start flow when degraded renew hits OAuth needs_auth", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const config = makeHarness(dir, fixture.mcpUrl, { hasUI: false }).deps.config;
		const authPlan = resolveServerAuth({ agentDir: dir, config, serverName: "fix" });
		const connection = new ServerConnection({
			authProvider: authPlan.provider,
			config,
			logger: createMcpLogger("fix"),
			serverName: "fix",
		});
		cleanups.push(() => connection.dispose());
		connection.markDegraded(new Error("stale test connection"));
		const entry: McpToolCatalogEntry = {
			connection,
			requestTimeoutMs: config.requestTimeoutMs,
			schema: { type: "object" },
			server: "fix",
			tool: "secure_tool",
		};
		const [tool] = buildMcpToolDefinitions([entry]);
		if (tool === undefined) throw new Error("expected MCP tool definition");

		await expect(tool.execute("tc-renew-auth", {}, undefined, undefined, testContext())).rejects.toThrow(
			/\/mcp auth-start fix/,
		);
	});

	it("refreshes near-expiry OAuth tokens through the real catalog and tool runtime path", async () => {
		const fixture = await idp(["--rotate-refresh"]);
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await harness.store.update((current) => ({ ...current, expiresAt: Date.now() + 60_000 }));
		const authPlan = resolveServerAuth({ agentDir: dir, config: harness.deps.config, serverName: "fix" });
		const connection = new ServerConnection({
			authProvider: authPlan.provider,
			config: harness.deps.config,
			logger: createMcpLogger("fix"),
			serverName: "fix",
		});
		cleanups.push(() => connection.dispose());
		const entry: McpConnectionEntry = {
			agentDir: dir,
			authPlan,
			cacheRefreshedAfterConnect: false,
			configHash: "runtime-refresh",
			connection,
			counters: { callCount: 0, errorCount: 0, reconnectCount: 0, totalLatencyMs: 0 },
			createdAtMs: Date.now(),
			key: "fix\0runtime-refresh",
			logger: createMcpLogger("fix"),
			name: "fix",
		};
		const beforeCatalog = (await fixture.getLog()).tokenHits;

		await connectAndRefreshMcpCatalog(entry, harness.deps.config);

		const afterCatalog = (await fixture.getLog()).tokenHits;
		expect(afterCatalog - beforeCatalog).toBe(1);
		expect(entry.cachedCatalog?.tools.map((tool) => tool.name)).toContain("tool_1");
		const pi = capturingPi();
		await registerMcpServiceDirectTools(
			pi,
			{
				diagnostics: [],
				servers: {
					fix: {
						config: harness.deps.config,
						configHash: entry.configHash,
						name: "fix",
						source: "global",
						sourcePath: "<test>",
						state: "enabled",
						transport: "http",
					},
				},
				settings: { outputGuard: { maxBytes: 50 * 1024, maxLines: 2000 }, searchThreshold: 10, toolPrefix: "mcp" },
			},
			[entry],
		);
		await harness.store.update((current) => ({ ...current, expiresAt: Date.now() + 60_000 }));
		const tool = registeredTool(pi, "mcp_fix_tool_1");
		const beforeCalls = (await fixture.getLog()).tokenHits;

		const [first, second] = await Promise.all([
			tool.execute("tc-runtime-1", { value: "one" }, undefined, undefined, testContext()),
			tool.execute("tc-runtime-2", { value: "two" }, undefined, undefined, testContext()),
		]);

		const afterCalls = await fixture.getLog();
		expect(afterCalls.tokenHits - beforeCalls).toBe(1);
		expect(afterCalls.familyInvalidated).toBe(false);
		expect(textContent(first)).toBe("fixture tool_1 value=one mode=alpha");
		expect(textContent(second)).toBe("fixture tool_1 value=two mode=alpha");
	});

	it("marks needs_auth with auth-start guidance when catalog refresh sees revoked refresh credentials", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await poisonRefreshToken(harness);
		const authPlan = resolveServerAuth({ agentDir: dir, config: harness.deps.config, serverName: "fix" });
		const connection = new ServerConnection({
			authProvider: authPlan.provider,
			config: harness.deps.config,
			logger: createMcpLogger("fix"),
			serverName: "fix",
		});
		cleanups.push(() => connection.dispose());
		const entry: McpConnectionEntry = {
			agentDir: dir,
			authPlan,
			cacheRefreshedAfterConnect: false,
			configHash: "runtime-invalid-refresh",
			connection,
			counters: { callCount: 0, errorCount: 0, reconnectCount: 0, totalLatencyMs: 0 },
			createdAtMs: Date.now(),
			key: "fix\0runtime-invalid-refresh",
			logger: createMcpLogger("fix"),
			name: "fix",
		};

		await expect(connectAndRefreshMcpCatalog(entry, harness.deps.config)).rejects.toThrow(/\/mcp auth-start fix/);

		expect(connection.state).toBe("needs_auth");
		expect(connection.lastError?.message).toMatch(/\/mcp auth-start fix/);
		expect(entry.cachedCatalog).toBeUndefined();
		expect(harness.store.read()).toBeUndefined();
	});

	it("keeps attachSession alive with needs_auth guidance when startup refresh sees revoked credentials", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, redirect);
		await poisonRefreshToken(harness);
		await writeMcpConfig(dir, harness.deps.config);
		const service = new McpService();
		cleanups.push(() => service.dispose("quit"));
		const pi = capturingPi();

		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: dir, isProjectTrusted: () => true },
			pi,
			{ agentDir: dir },
		);

		expect(service.getServerSnapshots()).toMatchObject([
			{
				lastError: expect.stringMatching(/\/mcp auth-start fix/),
				lifecycleState: "needs_auth",
				name: "fix",
			},
		]);
		expect(pi.registeredTools).toEqual([]);
		expect(harness.store.read()).toBeUndefined();
	});

	it("surfaces auth-start guidance on manual reconnect when refresh credentials were rotated away", async () => {
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
		expect(service.getConnection("fix")?.state).toBe("connected");
		await poisonRefreshToken(harness);

		await expect(service.reconnectServer("fix")).rejects.toThrow(/\/mcp auth-start fix/);

		expect(service.getServerSnapshots()).toMatchObject([
			{
				lastError: expect.stringMatching(/\/mcp auth-start fix/),
				lifecycleState: "needs_auth",
				name: "fix",
			},
		]);
		expect(harness.store.read()).toBeUndefined();
	});
});

function lastNote(notes: readonly { message: string; type: string }[]): { message: string; type: string } | undefined {
	return notes[notes.length - 1];
}
