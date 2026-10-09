// Authorization responses and token responses the MCP OAuth flow must accept or
// refuse: RFC 9207 `iss` checks, servers that send `null` / `""` for optional
// fields, re-authorization scope, and fetch calls without a receiver.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthCommandDeps } from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { runAuth, runAuthComplete, runAuthStart } from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { resolveServerAuth } from "../../src/core/extensions/builtin/mcp/auth/context.ts";
import type { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function idp(args: string[] = []): Promise<IdpFixture> {
	const fixture = await spawnOAuthIdp(args);
	cleanups.push(fixture.cleanup);
	return fixture;
}

async function agentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-authz-response-"));
	cleanups.push(() => rm(dir, { force: true, recursive: true }));
	return dir;
}

interface AuthHarness {
	deps: AuthCommandDeps;
	store: McpTokenStore;
	browserVisits: Promise<unknown>[];
}

function serverConfig(mcpUrl: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		type: "http",
		url: mcpUrl,
		args: [],
		enabled: true,
		lifecycle: "lazy",
		connectTimeoutMs: 4000,
		requestTimeoutMs: 4000,
		startupTimeoutMs: 250,
		idleTimeoutMin: 10,
		exposure: "auto",
		logLevel: "info",
		...overrides,
	};
}

function makeHarness(dir: string, mcpUrl: string, overrides: Partial<McpServerConfig> = {}): AuthHarness {
	const browserVisits: Promise<unknown>[] = [];
	const deps: AuthCommandDeps = {
		serverName: "fix",
		config: serverConfig(mcpUrl, overrides),
		agentDir: dir,
		hasUI: true,
		notify: () => undefined,
		// A browser that approves at once and lands on the loopback callback.
		openBrowser: (url) => {
			browserVisits.push(followAuthorize(url.href).then((location) => fetch(location)));
		},
		onReconnect: () => Promise.resolve(),
		pending: new Map<string, McpOAuthProvider>(),
	};
	return { deps, browserVisits, store: new McpTokenStore({ agentDir: dir, serverName: "fix", serverUrl: mcpUrl }) };
}

async function followAuthorize(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (location === null) throw new Error(`no redirect: ${response.status}`);
	return location;
}

async function authorizationCodeExchanges(fixture: IdpFixture): Promise<number> {
	const log = await fixture.getLog();
	return log.requests.filter((request) => request.grantType === "authorization_code").length;
}

describe("RFC 9207 authorization response issuer", () => {
	it("refuses a pasted redirect whose iss names another authorization server", async () => {
		const fixture = await idp(["--iss", "mismatch"]);
		const harness = makeHarness(await agentDir(), fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));

		await expect(runAuthComplete(harness.deps, redirect)).rejects.toMatchObject({ name: "OAuthFlowError" });
		expect(await authorizationCodeExchanges(fixture)).toBe(0);
		expect(harness.store.read()?.accessToken).toBeUndefined();
	});

	it("refuses a loopback callback whose iss names another authorization server", async () => {
		const fixture = await idp(["--iss", "mismatch"]);
		const harness = makeHarness(await agentDir(), fixture.mcpUrl);

		await expect(runAuth(harness.deps)).rejects.toMatchObject({ name: "OAuthFlowError" });
		await Promise.allSettled(harness.browserVisits);
		expect(await authorizationCodeExchanges(fixture)).toBe(0);
		expect(harness.store.read()?.accessToken).toBeUndefined();
	});

	it("refuses a response without iss when the server promises to send it", async () => {
		const fixture = await idp(["--iss-supported"]);
		const harness = makeHarness(await agentDir(), fixture.mcpUrl);
		const redirect = await followAuthorize(await runAuthStart(harness.deps));

		await expect(runAuthComplete(harness.deps, redirect)).rejects.toMatchObject({ name: "OAuthFlowError" });
		expect(await authorizationCodeExchanges(fixture)).toBe(0);
		expect(harness.store.read()?.accessToken).toBeUndefined();
	});

	it("signs in when iss names this authorization server, by paste and by loopback", async () => {
		const fixture = await idp(["--iss", "match", "--iss-supported"]);
		const pasted = makeHarness(await agentDir(), fixture.mcpUrl);
		await runAuthComplete(pasted.deps, await followAuthorize(await runAuthStart(pasted.deps)));
		expect(pasted.store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);

		const loopback = makeHarness(await agentDir(), fixture.mcpUrl);
		await runAuth(loopback.deps);
		await Promise.all(loopback.browserVisits);
		expect(loopback.store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
	});
});

describe("optional OAuth fields sent as null or empty", () => {
	it("signs in and keeps a usable, unexpired token", async () => {
		const fixture = await idp(["--null-optional-fields"]);
		const dir = await agentDir();
		const harness = makeHarness(dir, fixture.mcpUrl);

		await runAuthComplete(harness.deps, await followAuthorize(await runAuthStart(harness.deps)));

		const record = harness.store.read();
		expect(record?.accessToken).toMatch(/^SENTINEL_AT_/);
		expect(record?.expiresAt).toBeUndefined();
		expect(record?.refreshToken).toBeUndefined();
		expect(record?.clientInfo?.client_id).toMatch(/^dcr-/);
		expect(record?.clientInfo?.client_secret).toBeUndefined();

		// The stored token authorizes MCP requests without another sign-in.
		const config = serverConfig(fixture.mcpUrl);
		const authPlan = resolveServerAuth({ agentDir: dir, config, serverName: "fix" });
		const connection = new ServerConnection({
			authProvider: authPlan.provider,
			config,
			logger: createMcpLogger("fix"),
			serverName: "fix",
		});
		cleanups.push(() => connection.dispose());
		const client = await connection.connect();
		const listed = await client.listTools({}, { timeout: 4000 });
		expect(listed.tools.length).toBeGreaterThan(0);
	});
});

describe("re-authorization scope", () => {
	it("a second sign-in requests every configured scope, never a narrower set", async () => {
		const fixture = await idp();
		const harness = makeHarness(await agentDir(), fixture.mcpUrl, { oauth: { scopes: ["mcp", "offline_access"] } });
		const first = new URL(await runAuthStart(harness.deps));
		await runAuthComplete(harness.deps, await followAuthorize(first.href));
		// The granted token is gone (revoked or expired without a refresh token), so the next sign-in is interactive.
		await harness.store.update((record) =>
			record === undefined
				? undefined
				: { ...record, accessToken: undefined, refreshToken: undefined, expiresAt: undefined },
		);

		const second = new URL(await runAuthStart(harness.deps));

		expect(first.searchParams.get("scope")).toBe("mcp offline_access");
		expect(second.searchParams.get("scope")).toBe("mcp offline_access");
	});
});

describe("fetch receiver", () => {
	it("signs in and talks to the server without calling fetch as a method", async () => {
		const fixture = await idp();
		const dir = await agentDir();
		const original = globalThis.fetch;
		const receivers: unknown[] = [];
		globalThis.fetch = function receiverCheckingFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
			if (this !== undefined && this !== globalThis) receivers.push(this);
			return original(input, init);
		} as typeof fetch;
		cleanups.push(async () => {
			globalThis.fetch = original;
		});
		const harness = makeHarness(dir, fixture.mcpUrl);
		await runAuthComplete(harness.deps, await followAuthorize(await runAuthStart(harness.deps)));
		const config = serverConfig(fixture.mcpUrl);
		const connection = new ServerConnection({
			authProvider: resolveServerAuth({ agentDir: dir, config, serverName: "fix" }).provider,
			config,
			logger: createMcpLogger("fix"),
			serverName: "fix",
		});
		cleanups.push(() => connection.dispose());
		const client = await connection.connect();
		await client.listTools({}, { timeout: 4000 });

		expect(receivers).toEqual([]);
	});
});
