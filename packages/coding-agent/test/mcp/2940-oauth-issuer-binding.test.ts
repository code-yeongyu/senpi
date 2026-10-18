import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import { beginAuthorization, completeAuthorization } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

// senpi#2940: stored MCP OAuth credentials are bound to the authorization server that issued them
// (GHSA-6qxp-vccf-f47h). A refresh token is never posted to another authorization server, and a
// mismatch is a continuity break: the credentials are discarded and the user signs in again.

const OTHER_AS = "https://other-authorization-server.invalid";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(): Promise<{ fixture: IdpFixture; store: McpTokenStore; provider: McpOAuthProvider }> {
	const fixture = await spawnOAuthIdp();
	cleanups.push(fixture.cleanup);
	const agentDir = await mkdtemp(join(tmpdir(), "mcp-issuer-"));
	cleanups.push(() => rm(agentDir, { force: true, recursive: true }));
	const store = new McpTokenStore({ agentDir, serverName: "fix", serverUrl: fixture.mcpUrl });
	const provider = new McpOAuthProvider({
		serverName: "fix",
		serverUrl: fixture.mcpUrl,
		store,
		redirectUrl: "http://127.0.0.1:8123/callback",
		scopes: ["mcp"],
		clientId: "static-client",
	});
	return { fixture, store, provider };
}

async function signIn(provider: McpOAuthProvider): Promise<void> {
	const begin = await beginAuthorization(provider);
	const response = await fetch(begin.authorizationUrl as URL, { redirect: "manual" });
	const location = response.headers.get("location");
	if (location === null) throw new Error(`authorize did not redirect: ${response.status}`);
	await completeAuthorization(provider, location);
}

const sameServer = (a: string | undefined, b: string): boolean =>
	a !== undefined && a.replace(/\/$/, "") === b.replace(/\/$/, "");

describe("MCP OAuth credentials stay with the authorization server that issued them (senpi#2940)", () => {
	it("#given a sign-in #then the stored tokens record their issuer, and provider.tokens() hands it to the SDK", async () => {
		const { fixture, store, provider } = await setup();
		await signIn(provider);
		expect(sameServer(store.read()?.issuer, fixture.baseUrl)).toBe(true);
		expect(sameServer(provider.tokens()?.issuer, fixture.baseUrl)).toBe(true);
	});

	it("#given tokens issued by another authorization server #when a refresh is due #then the refresh token is not sent and the credentials are discarded for a fresh sign-in", async () => {
		const { fixture, store, provider } = await setup();
		await signIn(provider);
		await store.update((current) => ({ ...current, issuer: OTHER_AS, expiresAt: Date.now() + 60_000 }));
		const before = (await fixture.getLog()).tokenHits;

		await expect(new McpRefreshManager(provider).ensureFresh()).rejects.toMatchObject({
			oauthKind: "needs_auth",
			terminal: true,
		});

		expect((await fixture.getLog()).tokenHits).toBe(before);
		expect(store.read()).toBeUndefined();
	});

	it("#given a refresh at the issuing authorization server #then the rotated tokens keep the issuer stamp", async () => {
		const { fixture, store, provider } = await setup();
		await signIn(provider);
		await store.update((current) => ({ ...current, expiresAt: Date.now() + 60_000 }));

		await new McpRefreshManager(provider).ensureFresh();

		expect(sameServer(store.read()?.issuer, fixture.baseUrl)).toBe(true);
	});

	it("#given tokens saved by an older senpi with the sign-in's discovery record #then they bind to that authorization server and refresh there", async () => {
		const { fixture, store, provider } = await setup();
		await signIn(provider);
		await store.update((current) => {
			const { issuer: _dropped, ...older } = current ?? {};
			return { ...older, expiresAt: Date.now() + 60_000 };
		});
		const before = (await fixture.getLog()).tokenHits;

		await new McpRefreshManager(provider).ensureFresh();

		expect((await fixture.getLog()).tokenHits).toBe(before + 1);
		expect(sameServer(store.read()?.issuer, fixture.baseUrl)).toBe(true);
	});

	it("#given tokens saved by an older senpi with no record of their authorization server #then nothing is sent and a fresh sign-in is required", async () => {
		const { fixture, store, provider } = await setup();
		await store.write({
			accessToken: "AT_older",
			refreshToken: "RT_older",
			expiresAt: Date.now() + 60_000,
			resource: fixture.mcpUrl,
		});
		const before = (await fixture.getLog()).tokenHits;

		expect(provider.tokens()?.refresh_token).toBeUndefined();
		await expect(new McpRefreshManager(provider).ensureFresh()).rejects.toMatchObject({
			oauthKind: "needs_auth",
			terminal: true,
		});

		expect((await fixture.getLog()).tokenHits).toBe(before);
		expect(store.read()).toBeUndefined();
	});

	it("#given an unattributed saved grant #when a sign-in or the SDK's auth() runs discovery #then its refresh token is never sent to the server discovered now", async () => {
		for (const run of ["beginAuthorization", "sdk auth()"] as const) {
			const { fixture, store, provider } = await setup();
			await store.write({
				accessToken: "AT_older",
				refreshToken: "RT_older",
				expiresAt: Date.now() + 60_000,
				resource: fixture.mcpUrl,
			});

			if (run === "beginAuthorization") await beginAuthorization(provider);
			else await auth(provider, { serverUrl: fixture.mcpUrl });

			const refreshes = (await fixture.getLog()).requests.filter((entry) => entry.grantType === "refresh_token");
			expect({ run, refreshes: refreshes.length }).toEqual({ run, refreshes: 0 });
			expect(provider.tokens()?.refresh_token).toBeUndefined();
		}
	});

	it("#given a saved grant whose sign-in discovered another authorization server #when the SDK's auth() rediscovers #then the grant stays bound to the original server and nothing is sent", async () => {
		const { fixture, store, provider } = await setup();
		await store.write({
			accessToken: "AT_older",
			refreshToken: "RT_older",
			expiresAt: Date.now() + 60_000,
			resource: fixture.mcpUrl,
			discoveryState: { authorizationServerUrl: OTHER_AS },
		});

		await auth(provider, { serverUrl: fixture.mcpUrl });

		const refreshes = (await fixture.getLog()).requests.filter((entry) => entry.grantType === "refresh_token");
		expect(refreshes).toHaveLength(0);
		expect(store.read()?.issuer).toBe(OTHER_AS);
	});
});
