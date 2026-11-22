import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";
import { McpTokenStore } from "../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { addGrant, GrantsLockLostError } from "../src/core/extensions/builtin/mcp/env-grants-store.ts";
import { FileLockLostError } from "../src/core/file-lock.ts";
import { parseMoveId } from "../src/core/session-move/bundle.ts";
import { MoveLedger } from "../src/core/session-move/move-ledger.ts";

const realLock = lockfile.lock;
const dirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "file-lock-lost-"));
	dirs.push(dir);
	return dir;
}

function compromised(): Error {
	return Object.assign(new Error("Unable to update lock within the stale threshold"), { code: "ECOMPROMISED" });
}

function loseEveryLockRightAfterAcquire(): void {
	vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
		const release = await realLock(file, options);
		await release();
		options?.onCompromised?.(compromised());
		return async () => {};
	});
}

describe("a write under a lost lock is refused", () => {
	it("an OAuth refresh that lost its lock during the network round-trip does not write the new tokens", async () => {
		const store = new McpTokenStore({
			agentDir: await tempDir(),
			serverName: "s",
			serverUrl: "https://mcp.example/mcp",
		});
		await store.write({ accessToken: "old-access", refreshToken: "old-refresh" });
		const before = readFileSync(store.tokensPath, "utf8");

		let lose: (() => void) | undefined;
		vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			const release = await realLock(file, options);
			lose = () => {
				void release();
				options?.onCompromised?.(compromised());
			};
			return release;
		});
		const refresh = store.withLock(async () => {
			expect(store.readUnlocked()?.refreshToken).toBe("old-refresh");
			lose?.();
			store.writeUnlocked({ accessToken: "new-access", refreshToken: "new-refresh" });
		});

		await expect(refresh).rejects.toBeInstanceOf(FileLockLostError);
		expect(readFileSync(store.tokensPath, "utf8")).toBe(before);
	});

	it("token-store update and clear do not touch the tokens after the lock was lost", async () => {
		const store = new McpTokenStore({
			agentDir: await tempDir(),
			serverName: "s",
			serverUrl: "https://mcp.example/mcp",
		});
		await store.write({ accessToken: "kept" });
		const before = readFileSync(store.tokensPath, "utf8");
		loseEveryLockRightAfterAcquire();

		await expect(store.update(() => ({ accessToken: "overwritten" }))).rejects.toBeInstanceOf(FileLockLostError);
		await expect(store.clear()).rejects.toBeInstanceOf(FileLockLostError);
		expect(readFileSync(store.tokensPath, "utf8")).toBe(before);
	});

	// senpi#3796: a grant saved after its lock was reclaimed would overwrite the new owner's grants.
	it("an MCP environment grant is not saved after the lock was lost", async () => {
		const path = join(await tempDir(), "mcp-env-grants.json");
		const label = { project: "p", skill: "s", server: "srv" };
		await addGrant(path, "a".repeat(64), label, ["KEPT"]);
		const before = readFileSync(path, "utf8");
		loseEveryLockRightAfterAcquire();

		await expect(addGrant(path, "b".repeat(64), label, ["NEW"])).rejects.toBeInstanceOf(GrantsLockLostError);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readdirSync(dirname(path))).toEqual(["mcp-env-grants.json"]);
	});

	it("a move-ledger record is not written after the lock was lost", async () => {
		const dir = await tempDir();
		const ledger = new MoveLedger(dir);
		const moveId = parseMoveId("0123456789abcdef0123456789abcdef");
		loseEveryLockRightAfterAcquire();

		await expect(ledger.prepare(moveId)).rejects.toBeInstanceOf(FileLockLostError);
		expect(existsSync(join(dir, "0123456789abcdef0123456789abcdef.json"))).toBe(false);
	});

	it("the credential-pool state file is not written after the lock was lost", async () => {
		const path = join(await tempDir(), "pool-state.json");
		const repository = new CredentialSlotRepository(path, { lockWaitBudgetMs: 1_000 });
		loseEveryLockRightAfterAcquire();

		await expect(repository.installationKey()).rejects.toBeInstanceOf(FileLockLostError);
		expect(existsSync(path)).toBe(false);
	});
});
