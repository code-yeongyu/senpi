// Servers that share one URL (for example a work and a personal account of the
// same MCP service) must keep separate OAuth credentials, and credentials an
// older senpi stored by URL alone move to the first server that loads them.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { hashServerUrl, McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";

const SERVER_URL = "https://mcp.example.com/mcp";
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function makeAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-token-store-per-server-"));
	dirs.push(dir);
	return dir;
}

function provider(agentDir: string, serverName: string): McpOAuthProvider {
	return new McpOAuthProvider({
		serverName,
		serverUrl: SERVER_URL,
		store: new McpTokenStore({ agentDir, serverName, serverUrl: SERVER_URL }),
		redirectUrl: "http://127.0.0.1:0/callback",
	});
}

/** Credentials as an older senpi wrote them: one directory per server URL. */
function writeLegacyCredentials(agentDir: string, accessToken: string): string {
	const dir = join(agentDir, "mcp-auth", hashServerUrl(SERVER_URL));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, "tokens.json");
	writeFileSync(path, `${JSON.stringify({ accessToken, refreshToken: "legacy-rt", resource: SERVER_URL })}\n`, {
		mode: 0o600,
	});
	return path;
}

describe("MCP OAuth credentials per server name and URL", () => {
	it("keeps separate tokens for two servers sharing a URL", async () => {
		const agentDir = await makeAgentDir();
		await provider(agentDir, "work").saveTokens({ access_token: "work-token", token_type: "Bearer" });
		await provider(agentDir, "personal").saveTokens({ access_token: "personal-token", token_type: "Bearer" });

		expect(provider(agentDir, "work").tokens()?.access_token).toBe("work-token");
		expect(provider(agentDir, "personal").tokens()?.access_token).toBe("personal-token");
	});

	it("signing out of one server keeps the other server's tokens", async () => {
		const agentDir = await makeAgentDir();
		await provider(agentDir, "work").saveTokens({ access_token: "work-token", token_type: "Bearer" });
		await provider(agentDir, "personal").saveTokens({ access_token: "personal-token", token_type: "Bearer" });

		await provider(agentDir, "work").invalidateCredentials("all");

		expect(provider(agentDir, "work").tokens()).toBeUndefined();
		expect(provider(agentDir, "personal").tokens()?.access_token).toBe("personal-token");
	});

	it("moves URL-keyed credentials to the first server that loads them", async () => {
		const agentDir = await makeAgentDir();
		const legacyPath = writeLegacyCredentials(agentDir, "legacy-token");

		// The access token moves with the record. Its refresh token is withheld: a URL-keyed record this old names no
		// authorization server (no issuer, no discovery record), so it is never presented anywhere (senpi#2940).
		expect(provider(agentDir, "work").tokens()).toMatchObject({ access_token: "legacy-token" });
		expect(provider(agentDir, "work").tokens()?.refresh_token).toBeUndefined();
		// Another server with the same URL signs in again instead of reusing the account.
		expect(provider(agentDir, "personal").tokens()).toBeUndefined();
		expect(existsSync(legacyPath)).toBe(false);
		expect(provider(agentDir, "work").tokens()?.access_token).toBe("legacy-token");
	});

	it("signing out removes URL-keyed credentials the server would take over", async () => {
		const agentDir = await makeAgentDir();
		const legacyPath = writeLegacyCredentials(agentDir, "legacy-token");

		await provider(agentDir, "work").invalidateCredentials("all");

		expect(existsSync(legacyPath)).toBe(false);
		expect(provider(agentDir, "work").tokens()).toBeUndefined();
		expect(provider(agentDir, "personal").tokens()).toBeUndefined();
	});
});
