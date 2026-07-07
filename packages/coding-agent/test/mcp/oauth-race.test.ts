import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { beginAuthorization, completeAuthorization } from "../../src/core/extensions/builtin/mcp/auth/oauth.ts";
import { McpOAuthProvider } from "../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { type IdpFixture, spawnOAuthIdp } from "./fixtures/spawn-idp.ts";

const execFileAsync = promisify(execFile);
const workerPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "oauth-race-worker.ts");
const artifactDir = process.env.TODO27_RACE_ARTIFACT_DIR;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

interface RaceArtifact {
	scenario: "lock-on" | "lock-off";
	idpPid: number;
	agentDir: string;
	tokenHitsDelta: number;
	familyInvalidated: boolean;
	storeCleared: boolean;
	initialRefreshHash?: string;
	storedRefreshHash?: string;
	results: WorkerResult[];
	requests: IdpFixtureLogRequest[];
}

type IdpFixtureLogRequest = Awaited<ReturnType<IdpFixture["getLog"]>>["requests"][number];

const raceArtifacts: RaceArtifact[] = [];

afterAll(async () => {
	if (artifactDir === undefined) return;
	await mkdir(artifactDir, { recursive: true });
	await writeFile(
		join(artifactDir, "race-transcript-request-log.json"),
		`${JSON.stringify(raceArtifacts, null, 2)}\n`,
	);
	for (const artifact of raceArtifacts) {
		const file =
			artifact.scenario === "lock-on"
				? "lock-on-happy-proof.json"
				: "lock-off-family-invalidation-control-proof.json";
		await writeFile(join(artifactDir, file), `${JSON.stringify(artifact, null, 2)}\n`);
	}
	const cleanupLines = raceArtifacts.flatMap((artifact) => [
		`${artifact.scenario} idp pid ${artifact.idpPid} alive: ${isProcessAlive(artifact.idpPid) ? "yes" : "no"}`,
		`${artifact.scenario} agent dir exists: ${existsSync(artifact.agentDir) ? "yes" : "no"}`,
	]);
	await writeFile(
		join(artifactDir, "cleanup-receipt.md"),
		[`# Cleanup receipt`, "", ...cleanupLines, "", "Real auth unchanged: verified by senpi-qa receipts."].join("\n"),
	);
});

async function idp(): Promise<IdpFixture> {
	const fixture = await spawnOAuthIdp(["--rotate-refresh"]);
	cleanups.push(fixture.cleanup);
	return fixture;
}

async function seedNearExpiryToken(agentDir: string, mcpUrl: string): Promise<string> {
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
	const refreshToken = store.read()?.refreshToken;
	if (refreshToken === undefined) throw new Error("seed auth did not store a refresh token");
	// Make the stored access token look near-expiry so both workers try to refresh.
	await store.update((current) => ({ ...current, expiresAt: Date.now() + 60_000 }));
	return tokenFingerprint(refreshToken);
}

interface WorkerResult {
	tag: string;
	ok: boolean;
	refreshHash?: string;
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

function tokenFingerprint(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("cross-process refresh race", () => {
	it("serializes a simultaneous refresh to exactly one token request (lock ON)", async () => {
		const fixture = await idp();
		const agentDir = await mkdtemp(join(tmpdir(), "mcp-race-on-"));
		cleanups.push(() => rm(agentDir, { force: true, recursive: true }));
		const initialRefreshHash = await seedNearExpiryToken(agentDir, fixture.mcpUrl);
		const before = (await fixture.getLog()).tokenHits;

		const results = await runWorkers(agentDir, fixture.mcpUrl, false);
		const log = await fixture.getLog();
		const stored = new McpTokenStore({ agentDir, serverName: "race", serverUrl: fixture.mcpUrl }).read();

		expect(log.tokenHits - before).toBe(1);
		expect(log.familyInvalidated).toBe(false);
		expect(results.every((result) => result.ok)).toBe(true);
		// Both processes converge on the SAME rotated refresh token without logging the raw secret.
		expect(results[0]?.refreshHash).toBe(results[1]?.refreshHash);
		expect(results[0]?.refreshHash).toMatch(/^[a-f0-9]{16}$/);
		expect(results[0]?.refreshHash).not.toBe(initialRefreshHash);
		expect(stored?.refreshToken === undefined ? undefined : tokenFingerprint(stored.refreshToken)).toBe(
			results[0]?.refreshHash,
		);
		raceArtifacts.push({
			scenario: "lock-on",
			idpPid: fixture.pid,
			agentDir,
			tokenHitsDelta: log.tokenHits - before,
			familyInvalidated: log.familyInvalidated,
			storeCleared: stored === undefined,
			initialRefreshHash,
			storedRefreshHash: stored?.refreshToken === undefined ? undefined : tokenFingerprint(stored.refreshToken),
			results,
			requests: log.requests,
		});
	}, 30_000);

	it("control case (lock OFF) trips family invalidation — the disaster the lock prevents", async () => {
		const fixture = await idp();
		const agentDir = await mkdtemp(join(tmpdir(), "mcp-race-off-"));
		cleanups.push(() => rm(agentDir, { force: true, recursive: true }));
		await seedNearExpiryToken(agentDir, fixture.mcpUrl);
		const before = (await fixture.getLog()).tokenHits;

		const results = await runWorkers(agentDir, fixture.mcpUrl, true);
		const log = await fixture.getLog();
		const stored = new McpTokenStore({ agentDir, serverName: "race", serverUrl: fixture.mcpUrl }).read();

		expect(log.tokenHits - before).toBe(2);
		expect(log.familyInvalidated).toBe(true);
		// At least one process is left needing re-auth (invalid_grant).
		expect(results.some((result) => result.ok === false && result.kind === "invalid_grant")).toBe(true);
		expect(stored).toBeUndefined();
		raceArtifacts.push({
			scenario: "lock-off",
			idpPid: fixture.pid,
			agentDir,
			tokenHitsDelta: log.tokenHits - before,
			familyInvalidated: log.familyInvalidated,
			storeCleared: stored === undefined,
			storedRefreshHash: stored?.refreshToken === undefined ? undefined : tokenFingerprint(stored.refreshToken),
			results,
			requests: log.requests,
		});
	}, 30_000);
});
