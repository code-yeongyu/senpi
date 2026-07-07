import { mkdtemp, rm } from "node:fs/promises";
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
import { testContext } from "./fixtures/register-call.ts";
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
});

function lastNote(notes: readonly { message: string; type: string }[]): { message: string; type: string } | undefined {
	return notes[notes.length - 1];
}
