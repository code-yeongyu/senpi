import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { beginAuthorization, completeAuthorization } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

const execFileAsync = promisify(execFile);
const workerPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "oauth-race-worker.ts");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function idp(): Promise<IdpFixture> {
	const fixture = await spawnOAuthIdp(["--rotate-refresh"]);
	cleanups.push(fixture.cleanup);
	return fixture;
}

async function seedNearExpiryToken(agentDir: string, mcpUrl: string): Promise<void> {
	const store = new McpTokenStore({ agentDir, serverName: "race", serverUrl: mcpUrl });
	const provider = new McpOAuthProvider({
		serverName: "race",
		serverUrl: mcpUrl,
		store,
		clientId: "race-client",
		redirectUrl: "http://127.0.0.1:8123/callback",
	});
	const begin = await beginAuthorization(provider);
	const authUrl = begin.authorizationUrl;
	if (authUrl === undefined) throw new Error("no auth url");
	const response = await fetch(authUrl, { redirect: "manual" });
	await completeAuthorization(provider, response.headers.get("location") ?? "");
	// Make the stored access token look near-expiry so both workers try to refresh.
	await store.update((current) => ({ ...current, expiresAt: Date.now() + 60_000 }));
}

interface WorkerResult {
	tag: string;
	ok: boolean;
	refresh?: string;
	kind?: string;
}

async function runWorkers(agentDir: string, mcpUrl: string, disableLock: boolean): Promise<WorkerResult[]> {
	const barrier = join(agentDir, "barrier.txt");
	await writeFile(barrier, "");
	const flag = disableLock ? "1" : "0";
	const runs = await Promise.all(
		["A", "B"].map((tag) =>
			execFileAsync(process.execPath, [workerPath, agentDir, mcpUrl, barrier, tag, flag], { timeout: 20_000 }),
		),
	);
	return runs.map((run) => JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as WorkerResult);
}

describe("cross-process refresh race", () => {
	it("serializes a simultaneous refresh to exactly one token request (lock ON)", async () => {
		const fixture = await idp();
		const agentDir = await mkdtemp(join(tmpdir(), "mcp-race-on-"));
		cleanups.push(() => rm(agentDir, { force: true, recursive: true }));
		await seedNearExpiryToken(agentDir, fixture.mcpUrl);
		const before = (await fixture.getLog()).tokenHits;

		const results = await runWorkers(agentDir, fixture.mcpUrl, false);
		const log = await fixture.getLog();

		expect(log.tokenHits - before).toBe(1);
		expect(log.familyInvalidated).toBe(false);
		expect(results.every((result) => result.ok)).toBe(true);
		// Both processes converge on the SAME rotated refresh token.
		expect(results[0]?.refresh).toBe(results[1]?.refresh);
		expect(results[0]?.refresh).toMatch(/^SENTINEL_RT_/);
	}, 30_000);

	it("control case (lock OFF) trips family invalidation — the disaster the lock prevents", async () => {
		const fixture = await idp();
		const agentDir = await mkdtemp(join(tmpdir(), "mcp-race-off-"));
		cleanups.push(() => rm(agentDir, { force: true, recursive: true }));
		await seedNearExpiryToken(agentDir, fixture.mcpUrl);
		const before = (await fixture.getLog()).tokenHits;

		const results = await runWorkers(agentDir, fixture.mcpUrl, true);
		const log = await fixture.getLog();

		expect(log.tokenHits - before).toBe(2);
		expect(log.familyInvalidated).toBe(true);
		// At least one process is left needing re-auth (invalid_grant).
		expect(results.some((result) => result.ok === false && result.kind === "invalid_grant")).toBe(true);
	}, 30_000);
});
