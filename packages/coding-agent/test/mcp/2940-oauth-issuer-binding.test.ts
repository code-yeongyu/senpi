import dns from "node:dns";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	beginAuthorization,
	clientCredentialsGrant,
	completeAuthorization,
	finishAuthorization,
	logout,
} from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import {
	McpOAuthProvider,
	type McpOAuthProviderOptions,
} from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpRefreshManager } from "../../src/core/extensions/builtin/mcp/auth/oauth-refresh.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

// senpi#2940: stored MCP OAuth credentials are bound to the authorization server that issued them
// (GHSA-6qxp-vccf-f47h). A refresh token is never posted to another authorization server, and a
// mismatch is a continuity break: the credentials are discarded and the user signs in again.

const OTHER_AS = "https://other-authorization-server.invalid";
const cleanups: (() => Promise<void>)[] = [];

// senpi#4924: "nothing is sent" is asserted, not inferred from a fast NXDOMAIN. Every fetch and every name
// resolution is checked against the fixtures this case spawned; anything else is recorded and fails at once,
// so a request toward another authorization server is a deterministic failure instead of a resolver timeout.
const fixtureOrigins = new Set<string>();
let foreignIo: string[] = [];
const realFetch = globalThis.fetch;
const realLookup = dns.lookup;
const realPromisesLookup = dns.promises.lookup;
const blocked = (what: string): TypeError => new TypeError(`senpi#4924 guard: ${what} is not a fixture origin`);

beforeEach(() => {
	foreignIo = [];
	globalThis.fetch = (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (fixtureOrigins.has(url.origin)) return realFetch(input, init);
		foreignIo.push(`fetch ${init?.method ?? "GET"} ${url.href}`);
		return Promise.reject(blocked(url.origin));
	};
	dns.lookup = ((hostname: string, ...rest: unknown[]) => {
		foreignIo.push(`lookup ${hostname}`);
		const callback = rest.at(-1) as (error: NodeJS.ErrnoException) => void;
		process.nextTick(() => callback(Object.assign(blocked(hostname), { code: "ENOTFOUND" })));
	}) as typeof dns.lookup;
	dns.promises.lookup = ((hostname: string) => {
		foreignIo.push(`lookup ${hostname}`);
		return Promise.reject(Object.assign(blocked(hostname), { code: "ENOTFOUND" }));
	}) as typeof dns.promises.lookup;
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	dns.lookup = realLookup;
	dns.promises.lookup = realPromisesLookup;
	fixtureOrigins.clear();
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
	expect(foreignIo, "network I/O outside the fixture").toEqual([]);
});

async function setup(
	overrides: Partial<McpOAuthProviderOptions> = {},
): Promise<{ fixture: IdpFixture; store: McpTokenStore; provider: McpOAuthProvider }> {
	const fixture = await spawnOAuthIdp();
	cleanups.push(fixture.cleanup);
	fixtureOrigins.add(new URL(fixture.baseUrl).origin);
	fixtureOrigins.add(new URL(fixture.mcpUrl).origin);
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
		...overrides,
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

	it("#given a saved grant whose sign-in discovered another authorization server #when the SDK's auth() rediscovers #then nothing reaches that server and the grant is never attributed to the server discovered now", async () => {
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
		expect(store.read()?.refreshToken).toBeUndefined();
		expect(sameServer(store.read()?.issuer, fixture.baseUrl)).toBe(false);
	});
});

// senpi#4924 class sweep: every OAuth entry point that could resolve or contact an authorization server runs
// against a saved grant that belongs to another one. None may touch that server (the guard above fails the case
// on any lookup or request outside the fixture), and none may present the grant to the server discovered now.
type Seed = "discovered elsewhere" | "stamped elsewhere" | "registered elsewhere";
const entryPoints: {
	path: string;
	seed: Seed;
	options?: Partial<McpOAuthProviderOptions>;
	run: (provider: McpOAuthProvider, fixture: IdpFixture) => Promise<unknown>;
}[] = [
	{
		path: "SDK auth() (transport 401, modern http fetch)",
		seed: "discovered elsewhere",
		run: (provider, fixture) => auth(provider, { serverUrl: fixture.mcpUrl }),
	},
	{ path: "beginAuthorization (/mcp auth-start)", seed: "discovered elsewhere", run: (p) => beginAuthorization(p) },
	{
		path: "finishAuthorization (callback / paste code exchange)",
		seed: "discovered elsewhere",
		run: (p) => finishAuthorization(p, "code-from-callback"),
	},
	{
		path: "clientCredentialsGrant (client_credentials)",
		seed: "discovered elsewhere",
		run: (p) => clientCredentialsGrant(p),
	},
	{
		path: "McpRefreshManager.ensureFresh (refresh before use)",
		seed: "stamped elsewhere",
		run: (p) => new McpRefreshManager(p).ensureFresh(),
	},
	{
		path: "SDK auth() dynamic client registration",
		seed: "registered elsewhere",
		options: { clientId: undefined },
		run: (provider, fixture) => auth(provider, { serverUrl: fixture.mcpUrl }),
	},
	{ path: "logout (no token revocation)", seed: "stamped elsewhere", run: (p) => logout(p) },
];

describe("no OAuth entry point contacts an authorization server a saved grant is not bound to (senpi#4924)", () => {
	it.each(entryPoints)("$path", async ({ seed, options, run }) => {
		const { fixture, store, provider } = await setup(options);
		await store.write({
			accessToken: "AT_older",
			refreshToken: "RT_older",
			expiresAt: Date.now() + 60_000,
			resource: fixture.mcpUrl,
			...(seed === "stamped elsewhere"
				? { issuer: OTHER_AS }
				: { discoveryState: { authorizationServerUrl: OTHER_AS } }),
			...(seed === "registered elsewhere"
				? { clientInfo: { client_id: "dcr-elsewhere", issuer: OTHER_AS, redirect_uris: [] } }
				: {}),
		});

		await Promise.allSettled([run(provider, fixture)]);

		const log = await fixture.getLog();
		expect(log.requests.filter((entry) => entry.grantType === "refresh_token")).toHaveLength(0);
		expect(sameServer(store.read()?.issuer, fixture.baseUrl) && store.read()?.refreshToken === "RT_older").toBe(
			false,
		);
	});
});
