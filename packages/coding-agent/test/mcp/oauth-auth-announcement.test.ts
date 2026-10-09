import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AuthCommandDeps,
	runAuth,
	runAuthComplete,
} from "../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(callbackUrl?: string) {
	const fixture = await spawnOAuthIdp();
	cleanups.push(fixture.cleanup);
	const dir = await mkdtemp(join(tmpdir(), "mcp-auth-announcement-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const messages: string[] = [];
	const deps: AuthCommandDeps = {
		serverName: "fixture",
		agentDir: dir,
		hasUI: true,
		callbackUrl,
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
		notify: (message) => messages.push(message),
		onReconnect: async () => {},
		pending: new Map(),
	};
	return {
		deps,
		messages,
		store: new McpTokenStore({ agentDir: dir, serverName: "fixture", serverUrl: fixture.mcpUrl }),
	};
}

async function redirectFor(url: URL): Promise<string> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (!location) throw new Error(`Fixture authorization failed: ${response.status}`);
	return location;
}

// Regression: code-yeongyu/oh-my-openagent#6724.
describe("MCP authorization announcements", () => {
	it("retains the full URL while the prepared loopback flow completes", async () => {
		// Given: a real local issuer and an opener that immediately visits its redirect.
		const { deps, messages, store } = await harness();
		let openedUrl = "";
		let callbackStatus = 0;
		let announcementBeforeReconnect = "";
		deps.openBrowser = async (url) => {
			openedUrl = url.toString();
			callbackStatus = (await fetch(await redirectFor(url))).status;
		};
		deps.onReconnect = async () => {
			announcementBeforeReconnect = messages.at(-1) ?? "";
		};

		// When: the interactive command completes without any artificial delays.
		await runAuth(deps);

		// Then: the listener was ready, and progress did not replace the manual fallback.
		expect(callbackStatus).toBe(200);
		expect(openedUrl).not.toBe("");
		expect(announcementBeforeReconnect).toContain(openedUrl);
		expect(store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
	});

	it("keeps the URL beside the paste instruction with a callback override", async () => {
		// Given: callback delivery is explicitly owned by the paste command.
		const { deps, messages, store } = await harness("http://127.0.0.1:0/callback");
		let openedUrl: URL | undefined;
		deps.openBrowser = (url) => {
			openedUrl = url;
		};

		// When: auth hands off to auth-complete.
		await runAuth(deps);

		// Then: the last announcement contains the actual authorization URL.
		if (!openedUrl) throw new Error("No authorization URL");
		const announcement = messages.at(-1);
		const redirect = await redirectFor(openedUrl);
		await runAuthComplete(deps, redirect);
		expect(announcement).toContain(openedUrl.toString());
		expect(store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
	});

	it("preserves manual completion when the browser opener rejects", async () => {
		// Given: launching a browser is unavailable, but OAuth itself works.
		const { deps, messages, store } = await harness("http://127.0.0.1:0/callback");
		let authorizationUrl: URL | undefined;
		deps.openBrowser = async (url) => {
			authorizationUrl = url;
			throw new Error("Browser launcher unavailable");
		};

		// When: the user starts authorization and uses the printed URL manually.
		await runAuth(deps);

		// Then: the flow remains completable instead of discarding its pending state.
		if (!authorizationUrl) throw new Error("No authorization URL");
		const announcement = messages.at(-1);
		await runAuthComplete(deps, await redirectFor(authorizationUrl));
		expect(announcement).toContain(authorizationUrl.toString());
		expect(store.read()?.accessToken).toMatch(/^SENTINEL_AT_/);
	});
});
