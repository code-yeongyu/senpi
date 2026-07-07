import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginAuthorization, completeAuthorization } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function makeAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"));
	cleanups.push(() => rm(dir, { force: true, recursive: true }));
	return dir;
}

async function idp(args: string[] = []): Promise<IdpFixture> {
	const fixture = await spawnOAuthIdp(args);
	cleanups.push(fixture.cleanup);
	return fixture;
}

function makeProvider(
	agentDir: string,
	mcpUrl: string,
	extra: Partial<ConstructorParameters<typeof McpOAuthProvider>[0]> = {},
) {
	const store = new McpTokenStore({ agentDir, serverName: "fix", serverUrl: mcpUrl });
	const provider = new McpOAuthProvider({
		serverName: "fix",
		serverUrl: mcpUrl,
		store,
		redirectUrl: "http://127.0.0.1:8123/callback",
		scopes: ["mcp"],
		...extra,
	});
	return { store, provider };
}

// Browser stand-in: GET the authorize URL, read the 302 Location (redirect back
// to the loopback URL carrying code + state).
async function followAuthorize(authorizationUrl: URL): Promise<string> {
	const response = await fetch(authorizationUrl, { redirect: "manual" });
	const location = response.headers.get("location");
	if (location === null) throw new Error(`authorize did not redirect: ${response.status}`);
	return location;
}

describe("McpOAuthProvider + flows", () => {
	it("completes the code + PKCE happy path and stores tokens with RFC 8707 resource", async () => {
		const fixture = await idp();
		const agentDir = await makeAgentDir();
		const { store, provider } = makeProvider(agentDir, fixture.mcpUrl);

		const begin = await beginAuthorization(provider);
		expect(begin.status).toBe("redirect");
		expect(begin.authorizationUrl).toBeDefined();
		const authUrl = begin.authorizationUrl;
		if (authUrl === undefined) throw new Error("no auth url");
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
		expect(authUrl.searchParams.get("resource")).toContain("/mcp");

		const redirect = await followAuthorize(authUrl);
		await completeAuthorization(provider, redirect);

		expect(store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
		expect(store.read()?.refreshToken).toMatch(/^SENTINEL_RT_/);
		const log = await fixture.getLog();
		const tokenReq = log.requests.find((entry) => entry.grantType === "authorization_code");
		expect(tokenReq?.resource).toContain("/mcp");
	});

	it("refuses with a typed error when the AS lacks PKCE S256", async () => {
		const fixture = await idp(["--no-s256"]);
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, fixture.mcpUrl);
		await expect(beginAuthorization(provider)).rejects.toMatchObject({
			name: "OAuthFlowError",
			oauthKind: "s256_unsupported",
		});
	});

	it("prefers CIMD over DCR when clientMetadataUrl is configured", async () => {
		const fixture = await idp(["--cimd"]);
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, fixture.mcpUrl, {
			clientMetadataUrl: `${fixture.baseUrl}/cimd`,
		});
		const begin = await beginAuthorization(provider);
		const redirect = await followAuthorize(begin.authorizationUrl as URL);
		await completeAuthorization(provider, redirect);
		const log = await fixture.getLog();
		expect(log.registerHits).toBe(0);
	});

	it("refreshes exactly once under 10 parallel callers when near expiry", async () => {
		const fixture = await idp();
		const agentDir = await makeAgentDir();
		const { store, provider } = makeProvider(agentDir, fixture.mcpUrl, { clientId: "static-client" });
		const begin = await beginAuthorization(provider);
		await completeAuthorization(provider, await followAuthorize(begin.authorizationUrl as URL));
		// Force the stored access token to look near-expiry.
		await store.update((current) => ({ ...current, expiresAt: Date.now() + 60_000 }));
		const before = (await fixture.getLog()).tokenHits;

		const manager = new McpRefreshManager(provider);
		const results = await Promise.all(Array.from({ length: 10 }, () => manager.ensureFresh()));
		for (const tokens of results) expect(tokens?.access_token).toMatch(/^SENTINEL_AT_/);
		const after = (await fixture.getLog()).tokenHits;
		expect(after - before).toBe(1);
	});

	it("drops credentials and reports needs_auth on invalid_grant", async () => {
		const fixture = await idp();
		const agentDir = await makeAgentDir();
		const { store, provider } = makeProvider(agentDir, fixture.mcpUrl, { clientId: "static-client" });
		await store.write({
			accessToken: "AT_old",
			refreshToken: "RT_UNKNOWN",
			expiresAt: Date.now() + 60_000,
			resource: fixture.mcpUrl,
		});
		const manager = new McpRefreshManager(provider);
		await expect(manager.ensureFresh()).rejects.toMatchObject({ oauthKind: "invalid_grant", terminal: true });
		expect(store.read()?.accessToken).toBeUndefined();
		expect(store.read()?.refreshToken).toBeUndefined();
	});

	it("retries a transient token endpoint failure without clearing credentials (needs_auth NOT set)", async () => {
		const fixture = await idp();
		const agentDir = await makeAgentDir();
		const { store, provider } = makeProvider(agentDir, fixture.mcpUrl, { clientId: "static-client" });
		await store.write({
			accessToken: "AT_old",
			refreshToken: "RT_TRANSIENT",
			expiresAt: Date.now() + 60_000,
			resource: fixture.mcpUrl,
		});
		const manager = new McpRefreshManager(provider, { maxRetries: 2, retryDelayMs: 5 });
		await expect(manager.ensureFresh()).rejects.toMatchObject({ oauthKind: "transient", terminal: false });
		// Credentials preserved for the next attempt.
		expect(store.read()?.refreshToken).toBe("RT_TRANSIENT");
		const log = await fixture.getLog();
		expect(log.tokenHits).toBeGreaterThanOrEqual(3);
	});
});
