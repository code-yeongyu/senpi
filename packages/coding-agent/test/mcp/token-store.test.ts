import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	hashServerUrl,
	LockAcquireError,
	type McpStoredAuth,
	McpTokenStore,
} from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";

const execFileAsync = promisify(execFile);
const workerPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "token-store-worker.ts");
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function makeAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mcp-token-store-"));
	dirs.push(dir);
	return dir;
}

describe("McpTokenStore", () => {
	it("persists a record with 0700 dir and 0600 file, plus an index entry", async () => {
		const agentDir = await makeAgentDir();
		const store = new McpTokenStore({ agentDir, serverName: "linear", serverUrl: "https://mcp.linear.app/mcp" });
		await store.write({ tokens: { access_token: "AT", token_type: "Bearer" }, resource: "https://mcp.linear.app" });

		expect(statSync(store.dir).mode & 0o777).toBe(0o700);
		expect(statSync(store.tokensPath).mode & 0o777).toBe(0o600);
		expect(store.read()?.tokens?.access_token).toBe("AT");

		const index = JSON.parse(readFileSync(join(agentDir, "mcp-auth", "index.json"), "utf-8"));
		expect(index.linear).toBe(hashServerUrl("https://mcp.linear.app/mcp"));
	});

	it("supports locked read-modify-write updates", async () => {
		const agentDir = await makeAgentDir();
		const store = new McpTokenStore({ agentDir, serverName: "s", serverUrl: "https://s.example/mcp" });
		await store.update(() => ({ codeVerifier: "v1" }));
		await store.update((current) => ({ ...current, resource: "https://s.example" }));
		expect(store.read()).toMatchObject({ codeVerifier: "v1", resource: "https://s.example" });
	});

	it("hashes a path-traversal server name to a safe hex dir inside mcp-auth", async () => {
		const agentDir = await makeAgentDir();
		const store = new McpTokenStore({ agentDir, serverName: "../evil", serverUrl: "../evil" });
		await store.write({ codeVerifier: "x" });
		expect(store.dir).toBe(join(agentDir, "mcp-auth", hashServerUrl("../evil")));
		expect(/^[0-9a-f]{64}$/.test(hashServerUrl("../evil"))).toBe(true);
		// Nothing escaped the mcp-auth root.
		expect(existsSync(join(agentDir, "evil"))).toBe(false);
		expect(existsSync(join(dirname(agentDir), "evil"))).toBe(false);
		expect(store.dir.startsWith(join(agentDir, "mcp-auth"))).toBe(true);
	});

	it("clear() removes all traces including the index entry", async () => {
		const agentDir = await makeAgentDir();
		const store = new McpTokenStore({ agentDir, serverName: "gone", serverUrl: "https://gone.example/mcp" });
		await store.write({ tokens: { access_token: "AT", token_type: "Bearer" } });
		expect(existsSync(store.dir)).toBe(true);
		await store.clear();
		expect(existsSync(store.dir)).toBe(false);
		expect(store.read()).toBeUndefined();
		const index = JSON.parse(readFileSync(join(agentDir, "mcp-auth", "index.json"), "utf-8"));
		expect(index.gone).toBeUndefined();
	});

	it("serializes two concurrent processes doing 50 RMW each: one winner per round, no torn reads", async () => {
		const agentDir = await makeAgentDir();
		const serverUrl = "https://race.example/mcp";
		const rounds = 50;
		await Promise.all(
			["procA", "procB"].map((tag) =>
				execFileAsync(process.execPath, [workerPath, agentDir, serverUrl, "race", tag, String(rounds)], {
					timeout: 25_000,
				}),
			),
		);
		const store = new McpTokenStore<McpStoredAuth & { winners: Record<string, string>; writes: string[] }>({
			agentDir,
			serverName: "race",
			serverUrl,
		});
		const record = store.read();
		expect(record).toBeDefined();
		if (record === undefined) throw new Error("record missing");
		// No torn reads: every increment landed (2 processes * 50 rounds).
		expect(record.writes.length).toBe(2 * rounds);
		// Exactly one winner claimed per round.
		expect(Object.keys(record.winners).length).toBe(rounds);
		for (const winner of Object.values(record.winners)) {
			expect(["procA", "procB"]).toContain(winner);
		}
	}, 30_000);

	it("fails fast with a lock error naming the lock path when the lock is already held", async () => {
		const agentDir = await makeAgentDir();
		const store = new McpTokenStore({
			agentDir,
			serverName: "held",
			serverUrl: "https://held.example/mcp",
			lock: { retries: 0, stale: 60_000 },
		});
		// Seed the directory so the lock target exists, then grab the lock out-of-band.
		await store.write({ codeVerifier: "seed" });
		const release = await lockfile.lock(store.dir, { lockfilePath: store.lockPath, realpath: false, stale: 60_000 });
		try {
			await expect(store.update((current) => ({ ...current, codeVerifier: "should-not-write" }))).rejects.toThrow(
				LockAcquireError,
			);
			await expect(store.update((c) => c)).rejects.toThrow(store.lockPath);
			// No corruption: original value intact.
			expect(store.read()?.codeVerifier).toBe("seed");
		} finally {
			await release();
		}
	});
});
