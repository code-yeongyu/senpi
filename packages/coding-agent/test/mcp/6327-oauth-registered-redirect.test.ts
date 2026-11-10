import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AuthCommandDeps,
	runAuth,
	runAuthStart,
} from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { resolveServerAuth } from "../../src/core/extensions/builtin/mcp/auth/context.ts";
import { beginAuthorization } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import type { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

// Regression: senpi#6327 / code-yeongyu/oh-my-openagent#12963. A dynamic client registration names the
// redirect URI it was made for. A background connect registers the placeholder `http://127.0.0.1:0/callback`
// and every `/mcp auth` binds a new loopback port, so reusing the stored registration sent an authorize
// `redirect_uri` the `client_id` was never registered with; exact-matching servers answer
// `invalid_request: Mismatching Redirect URL`. The fixture runs in that exact-matching mode.

const PLACEHOLDER = "http://127.0.0.1:0/callback";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Harness {
	fixture: IdpFixture;
	deps: AuthCommandDeps;
	store: McpTokenStore;
}

async function harness(): Promise<Harness> {
	const fixture = await spawnOAuthIdp(["--strict-redirect"]);
	cleanups.push(fixture.cleanup);
	const dir = await mkdtemp(join(tmpdir(), "mcp-registered-redirect-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const deps: AuthCommandDeps = {
		serverName: "fixture",
		agentDir: dir,
		hasUI: true,
		config: {
			type: "http",
			url: fixture.mcpUrl,
			auth: "oauth",
			args: [],
			enabled: true,
			lifecycle: "lazy",
			connectTimeoutMs: 4000,
			requestTimeoutMs: 4000,
			startupTimeoutMs: 250,
			idleTimeoutMin: 10,
			exposure: "auto",
			logLevel: "info",
		},
		notify: () => undefined,
		onReconnect: async () => {},
		pending: new Map(),
	};
	const store = new McpTokenStore({ agentDir: dir, serverName: "fixture", serverUrl: fixture.mcpUrl });
	return { fixture, deps, store };
}

function provider(deps: AuthCommandDeps, redirectUrl?: string): McpOAuthProvider {
	const plan = resolveServerAuth({ agentDir: deps.agentDir, config: deps.config, redirectUrl, serverName: "fixture" });
	if (plan.provider === undefined) throw new Error("no OAuth provider");
	return plan.provider;
}

// What a background connect does on its first 401: the SDK registers the placeholder and stops at the redirect.
async function backgroundConnect(deps: AuthCommandDeps): Promise<void> {
	const begin = await beginAuthorization(provider(deps));
	expect(begin.status).toBe("redirect");
}

// Runs `/mcp auth` like a browser: open the authorize URL, follow the redirect back to the loopback listener.
async function interactiveAuth(deps: AuthCommandDeps): Promise<{ authorizeStatus: number; redirectUri: string }> {
	let opened!: (url: URL) => void;
	const authorizeUrl = new Promise<URL>((resolve) => {
		opened = resolve;
	});
	deps.openBrowser = opened;
	const auth = runAuth(deps);
	const settledFirst = auth.then(() => {
		throw new Error("/mcp auth settled without opening an authorize URL");
	});
	settledFirst.catch(() => undefined);
	const url = await Promise.race([authorizeUrl, settledFirst]);
	const redirectUri = url.searchParams.get("redirect_uri") ?? "";
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	// A rejected authorize leaves the listener waiting; answer it with an error so the flow settles.
	const callback = location ?? `${redirectUri}?error=access_denied&state=${url.searchParams.get("state")}`;
	await fetch(callback);
	await (location === null ? auth.catch(() => undefined) : auth);
	return { authorizeStatus: response.status, redirectUri };
}

describe("MCP OAuth registers the redirect URI it authorizes with (senpi#6327)", () => {
	it("/mcp auth after a background connect registers its bound loopback URI instead of reusing port 0", async () => {
		// Given: a background connect left a dynamic registration for the port-0 placeholder.
		const { fixture, deps, store } = await harness();
		await backgroundConnect(deps);
		expect((await fixture.getLog()).registrations.map((entry) => entry.redirectUris)).toEqual([[PLACEHOLDER]]);

		// When: the user runs /mcp auth, which binds a real loopback port.
		const { authorizeStatus, redirectUri } = await interactiveAuth(deps);

		// Then: the authorize request names a URI registered for its client, and sign-in completes.
		expect(authorizeStatus).toBe(302);
		const registrations = (await fixture.getLog()).registrations;
		expect(registrations.at(-1)?.redirectUris).toEqual([redirectUri]);
		expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/callback$/);
		expect(store.read()?.clientInfo?.client_id).toBe(registrations.at(-1)?.clientId);
		expect(store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
	});

	it("a second /mcp auth on a new port re-registers instead of reusing the first port's client", async () => {
		// Given: a completed sign-in whose grant is gone (revoked, logged out elsewhere).
		const { fixture, deps, store } = await harness();
		const first = await interactiveAuth(deps);
		expect(first.authorizeStatus).toBe(302);
		await store.update((current) => ({ ...current, accessToken: undefined, refreshToken: undefined }));

		// When: /mcp auth runs again and the OS hands out another port.
		const second = await interactiveAuth(deps);

		// Then: the second flow authorizes with a client registered for its own port.
		expect(second.redirectUri).not.toBe(first.redirectUri);
		expect(second.authorizeStatus).toBe(302);
		expect((await fixture.getLog()).registrations.map((entry) => entry.redirectUris)).toEqual([
			[first.redirectUri],
			[second.redirectUri],
		]);
		expect(store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
	});

	it("a flow that replaces a registration never presents the replaced client's grant", async () => {
		// Given: a registration for port 1 with the grant issued to it.
		const { deps, store } = await harness();
		const stale = { client_id: "dcr-stale", redirect_uris: ["http://127.0.0.1:1/callback"] };
		await store.update(() => ({ clientInfo: stale, accessToken: "AT-stale", refreshToken: "RT-stale" }));
		const flow = provider(deps, "http://127.0.0.1:2/callback");

		// When: the flow for port 2 asks for its client and registers a new one.
		expect(flow.clientInformation()).toBeUndefined();
		await flow.saveClientInformation({ client_id: "dcr-fresh", redirect_uris: ["http://127.0.0.1:2/callback"] });

		// Then: the stale grant is gone with its client, so the SDK cannot refresh it under the new client_id.
		expect(flow.clientInformation()?.client_id).toBe("dcr-fresh");
		expect(flow.tokens()).toBeUndefined();
		expect(store.read()?.refreshToken).toBeUndefined();
	});

	it("background connects keep the stored registration so an existing sign-in keeps refreshing", async () => {
		// Given: a registration for the port an earlier /mcp auth bound.
		const { deps, store } = await harness();
		const registration = { client_id: "dcr-signed-in", redirect_uris: ["http://127.0.0.1:43123/callback"] };
		await store.update(() => ({ clientInfo: registration, refreshToken: "RT-live" }));

		// When/Then: a background provider (placeholder redirect, never authorizes) still uses it.
		expect(provider(deps).clientInformation()?.client_id).toBe("dcr-signed-in");
	});

	it("/mcp auth-start after a background connect reuses the matching port-0 registration", async () => {
		// Given: a background connect registered the placeholder that auth-start also sends.
		const { fixture, deps } = await harness();
		await backgroundConnect(deps);

		// When: the paste flow starts.
		const url = new URL(await runAuthStart(deps));

		// Then: no second registration, and the authorize request is accepted.
		expect((await fixture.getLog()).registrations).toHaveLength(1);
		expect(url.searchParams.get("redirect_uri")).toBe(PLACEHOLDER);
		expect((await fetch(url, { redirect: "manual" })).status).toBe(302);
	});
});
