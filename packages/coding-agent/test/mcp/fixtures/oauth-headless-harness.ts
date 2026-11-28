/** Headless OAuth harness shared by the MCP OAuth test files: an IDP fixture, a scratch agent dir, auth-command deps. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthCommandDeps } from "../../../src/core/extensions/builtin/mcp/auth/commands-auth.ts";
import type { McpOAuthProvider } from "../../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import type { McpServerConfig } from "../../../src/core/extensions/builtin/mcp/config-schema.ts";
import { type IdpFixture, spawnOAuthIdp } from "./spawn-idp.ts";

export const cleanups: (() => Promise<void>)[] = [];
export async function idp(args: string[] = []): Promise<IdpFixture> {
	const fixture = await spawnOAuthIdp(args);
	cleanups.push(fixture.cleanup);
	return fixture;
}

export async function agentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-headless-"));
	cleanups.push(() => rm(dir, { force: true, recursive: true }));
	return dir;
}

export interface Harness {
	deps: AuthCommandDeps<McpServerConfig>;
	notes: { message: string; type: string }[];
	browsered: URL[];
	store: McpTokenStore;
}

export function makeHarness(
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
		startupTimeoutMs: 250,
		idleTimeoutMin: 10,
		exposure: "auto",
		logLevel: "info",
		...overrides,
	};
	const deps: AuthCommandDeps<McpServerConfig> = {
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

export async function followAuthorize(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (location === null) throw new Error(`no redirect: ${response.status}`);
	return location;
}

export async function poisonRefreshToken(harness: Harness): Promise<void> {
	await harness.store.update((current) => ({
		...current,
		expiresAt: Date.now() + 60_000,
		refreshToken: "RT_UNKNOWN",
	}));
}

export async function writeMcpConfig(dir: string, config: McpServerConfig): Promise<void> {
	await writeFile(join(dir, "mcp.json"), `${JSON.stringify({ mcpServers: { fix: config } }, null, 2)}\n`);
}
