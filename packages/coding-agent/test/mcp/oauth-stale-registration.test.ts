import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthCommandDeps } from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { runAuth, runAuthComplete, runAuthStart } from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import type { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

// Regression: a dynamic client registration is bound to the redirect URI it was
// created with. Background connects register the placeholder
// `http://127.0.0.1:0/callback`, while an interactive flow binds a real loopback
// port and `/mcp auth-start` sends the placeholder. Authorization servers that
// validate `redirect_uri` exactly (e.g. Neon) reject the mismatch after consent
// with "Invalid redirect URI", so an interactive flow must re-register whenever
// the stored registration names another redirect URI.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function idp(): Promise<IdpFixture> {
	const fixture = await spawnOAuthIdp(["--strict-redirect"]);
	cleanups.push(fixture.cleanup);
	return fixture;
}

async function agentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-stale-registration-"));
	cleanups.push(() => rm(dir, { force: true, recursive: true }));
	return dir;
}

interface Harness {
	deps: AuthCommandDeps;
	opened: Promise<URL>;
	store: McpTokenStore;
}

function makeHarness(dir: string, mcpUrl: string): Harness {
	const notes: { message: string; type: string }[] = [];
	let resolveOpened!: (url: URL) => void;
	const opened = new Promise<URL>((resolve) => {
		resolveOpened = resolve;
	});
	const config: McpServerConfig = {
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
	};
	const deps: AuthCommandDeps = {
		serverName: "fix",
		config,
		agentDir: dir,
		hasUI: true,
		notify: (message, type = "info") => notes.push({ message, type }),
		openBrowser: (url) => {
			resolveOpened(url);
		},
		onReconnect: () => Promise.resolve(),
		pending: new Map<string, McpOAuthProvider>(),
	};
	return { deps, opened, store: new McpTokenStore({ agentDir: dir, serverName: "fix", serverUrl: mcpUrl }) };
}

async function registerClient(fixture: IdpFixture, redirectUri: string): Promise<OAuthClientInformationFull> {
	const response = await fetch(`${fixture.baseUrl}/register`, {
		body: JSON.stringify({
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			client_name: "senpi",
		}),
		method: "POST",
	});
	if (response.status !== 201) throw new Error(`registration failed: ${response.status}`);
	return response.json() as Promise<OAuthClientInformationFull>;
}

async function seedClientInfo(harness: Harness, fixture: IdpFixture, redirectUri: string): Promise<string> {
	const registration = await registerClient(fixture, redirectUri);
	await harness.store.update((current) => ({ ...current, clientInfo: registration }));
	return registration.client_id;
}

async function followAuthorize(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (location === null) throw new Error(`no redirect: ${response.status}`);
	return location;
}

describe("mcp oauth dynamic registration vs flow redirect URI", () => {
	it("auth-start re-registers a dynamic client registered for another redirect URI", async () => {
		const fixture = await idp();
		const harness = makeHarness(await agentDir(), fixture.mcpUrl);
		const staleClientId = await seedClientInfo(harness, fixture, "http://127.0.0.1:1/callback");

		const url = await runAuthStart(harness.deps);

		const saved = harness.store.read()?.clientInfo as { client_id?: string; redirect_uris?: string[] } | undefined;
		expect(saved?.redirect_uris).toEqual(["http://127.0.0.1:0/callback"]);
		expect(saved?.client_id).not.toBe(staleClientId);
		expect(new URL(url).searchParams.get("client_id")).toBe(saved?.client_id);

		const redirect = await followAuthorize(url);
		await runAuthComplete(harness.deps, redirect);
		expect(harness.store.read()?.accessToken).toBeTruthy();
	});

	it("interactive auth re-registers a dynamic client registered for the background placeholder", async () => {
		const fixture = await idp();
		const harness = makeHarness(await agentDir(), fixture.mcpUrl);
		const staleClientId = await seedClientInfo(harness, fixture, "http://127.0.0.1:0/callback");

		const authPromise = runAuth(harness.deps);
		authPromise.catch(() => undefined);
		const url = await harness.opened;
		expect(new URL(url).searchParams.get("client_id")).not.toBe(staleClientId);

		const redirect = await followAuthorize(url.toString());
		await fetch(redirect);
		await authPromise;
		expect(harness.store.read()?.accessToken).toBeTruthy();
	});

	it("keeps a dynamic registration whose redirect URI matches the flow", async () => {
		const fixture = await idp();
		const harness = makeHarness(await agentDir(), fixture.mcpUrl);
		const clientId = await seedClientInfo(harness, fixture, "http://127.0.0.1:0/callback");

		const url = await runAuthStart(harness.deps);

		expect(new URL(url).searchParams.get("client_id")).toBe(clientId);
		expect((await fixture.getLog()).registerHits).toBe(1);
	});
});
