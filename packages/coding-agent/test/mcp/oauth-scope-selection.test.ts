import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginAuthorization, resolveAuthorizationScope } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function makeAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-scope-"));
	cleanups.push(() => rm(dir, { force: true, recursive: true }));
	return dir;
}

async function idp(args: string[] = []): Promise<IdpFixture> {
	const fixture = await spawnOAuthIdp(args);
	cleanups.push(fixture.cleanup);
	return fixture;
}

function makeProvider(agentDir: string, mcpUrl: string, scopes: string[]) {
	const store = new McpTokenStore({ agentDir, serverName: "scope-test", serverUrl: mcpUrl });
	const provider = new McpOAuthProvider({
		serverName: "scope-test",
		serverUrl: mcpUrl,
		store,
		redirectUrl: "http://127.0.0.1:8123/callback",
		scopes,
	});
	return { store, provider };
}

describe("resolveAuthorizationScope", () => {
	it("sends a configured scope verbatim over a narrower resource scope", async () => {
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, "https://mcp.example/mcp", [
			"openid",
			"email",
			"profile",
			"offline_access",
		]);
		// Vercel shape: the resource advertises only "openid", the AS offers more.
		const scope = resolveAuthorizationScope(provider, {
			authorizationServerMetadata: { scopes_supported: ["openid", "email", "profile", "offline_access"] },
			resourceMetadata: { scopes_supported: ["openid"] },
		});
		expect(scope).toBe("openid email profile offline_access");
	});

	it("adds offline_access to the resource scope when the authorization server offers it", async () => {
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, "https://mcp.example/mcp", []);
		const scope = resolveAuthorizationScope(provider, {
			authorizationServerMetadata: { scopes_supported: ["mcp", "offline_access"] },
			resourceMetadata: { scopes_supported: ["openid"] },
		});
		expect(scope).toBe("openid offline_access");
	});

	it("never requests offline_access the authorization server did not advertise", async () => {
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, "https://mcp.example/mcp", []);
		// Neon shape: a refresh_token grant without the offline_access scope.
		const neonAsMetadata = {
			scopes_supported: ["read", "write"],
			grant_types_supported: ["authorization_code", "refresh_token"],
		};
		const scope = resolveAuthorizationScope(provider, {
			authorizationServerMetadata: neonAsMetadata,
			resourceMetadata: { scopes_supported: [] },
		});
		expect(scope).toBeUndefined();
	});

	it("requests offline_access alone when the resource advertises no scopes", async () => {
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, "https://mcp.example/mcp", []);
		const scope = resolveAuthorizationScope(provider, {
			authorizationServerMetadata: { scopes_supported: ["offline_access"] },
			resourceMetadata: undefined,
		});
		expect(scope).toBe("offline_access");
	});
});

describe("authorize request scope", () => {
	it("carries the configured scope over a narrower resource scope and prompts for consent", async () => {
		const fixture = await idp(["--prm-scopes", "openid"]);
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, fixture.mcpUrl, ["mcp", "offline_access"]);

		const begin = await beginAuthorization(provider);
		const authUrl = begin.authorizationUrl;
		if (authUrl === undefined) throw new Error("no auth url");
		expect(authUrl.searchParams.get("scope")).toBe("mcp offline_access");
		expect(authUrl.searchParams.get("prompt")).toBe("consent");
	});

	it("gains offline_access when the AS offers it and no scope is configured", async () => {
		const fixture = await idp(["--prm-scopes", "openid"]);
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, fixture.mcpUrl, []);

		const begin = await beginAuthorization(provider);
		const authUrl = begin.authorizationUrl;
		if (authUrl === undefined) throw new Error("no auth url");
		expect(authUrl.searchParams.get("scope")).toBe("openid offline_access");
		expect(authUrl.searchParams.get("prompt")).toBe("consent");
	});

	it("sends no scope when neither configuration nor the AS offers one", async () => {
		const fixture = await idp(["--as-scopes", "mcp"]);
		const agentDir = await makeAgentDir();
		const { provider } = makeProvider(agentDir, fixture.mcpUrl, []);

		const begin = await beginAuthorization(provider);
		const authUrl = begin.authorizationUrl;
		if (authUrl === undefined) throw new Error("no auth url");
		expect(authUrl.searchParams.get("scope")).toBeNull();
		expect(authUrl.searchParams.get("prompt")).toBeNull();
	});
});
