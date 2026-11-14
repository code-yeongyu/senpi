import { renameSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireOwnershipSafeLock } from "../../../src/modes/rpc/ownership-safe-lock.ts";
import type { FileIdentity } from "../../../src/modes/rpc/sqlite-file-identity.ts";

// Swaps `path` for an impostor around SQLite's open of it (once, or on every open) and counts those opens.
const attacker = vi.hoisted(() => ({
	swap: undefined as { path: string; root: string; persistent: boolean; opens: number } | undefined,
}));

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class AttackedDatabaseSync extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			const swap = attacker.swap?.path === String(args[0]) ? attacker.swap : undefined;
			if (swap === undefined) {
				super(...args);
				return;
			}
			swap.opens += 1;
			if (!swap.persistent) attacker.swap = undefined;
			writeFileSync(join(swap.root, "impostor.lock"), "", { mode: 0o600 });
			renameSync(swap.path, join(swap.root, "parked.lock"));
			renameSync(join(swap.root, "impostor.lock"), swap.path);
			try {
				super(...args);
			} finally {
				renameSync(swap.path, join(swap.root, "impostor.lock"));
				renameSync(join(swap.root, "parked.lock"), swap.path);
			}
		}
	}
	return { ...actual, DatabaseSync: AttackedDatabaseSync };
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2). Security contract:
// while another connection of this process has the lock file open, a lock open whose file cannot be proven is retried
// as busy, never taken: an attacker who keeps swapping the name is refused at the deadline, and a one-time swap clears
// on the retry, which then takes the real lock.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("lock file busy retry", () => {
	const roots: string[] = [];
	const holders: DatabaseSync[] = [];

	afterEach(async () => {
		attacker.swap = undefined;
		for (const holder of holders.splice(0)) holder.close();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function heldLock(): Promise<{ root: string; lockPath: string; expectedFile: FileIdentity }> {
		const root = await realpath(await mkdtemp(join(tmpdir(), "rpc4199-lock-busy-")));
		roots.push(root);
		const lockPath = join(root, "rpc.sock.secret.publish.lock");
		writeFileSync(lockPath, "", { mode: 0o600 });
		const info = statSync(lockPath, { bigint: true });
		holders.push(new DatabaseSync(lockPath));
		return { root, lockPath, expectedFile: { dev: info.dev, ino: info.ino } };
	}

	it("retries a lock open swapped on every attempt as busy and refuses it at the deadline", async () => {
		const { root, lockPath, expectedFile } = await heldLock();
		attacker.swap = { path: lockPath, root, persistent: true, opens: 0 };
		const swap = attacker.swap;
		await expect(
			acquireOwnershipSafeLock(lockPath, { expectedFile, retries: { retries: 5, minTimeout: 1, maxTimeout: 10 } }),
		).rejects.toMatchObject({ code: "ELOCK_FILE_BUSY" });
		expect(swap.opens).toBeGreaterThan(1);
	});

	it("takes the real lock on the retry after a one-time swap", async () => {
		const { root, lockPath, expectedFile } = await heldLock();
		attacker.swap = { path: lockPath, root, persistent: false, opens: 0 };
		const swap = attacker.swap;
		const release = await acquireOwnershipSafeLock(lockPath, {
			expectedFile,
			retries: { retries: 50, minTimeout: 1, maxTimeout: 10 },
		});
		try {
			expect(swap.opens).toBe(1);
			// The lock held is on the validated file: another lock attempt on it is busy.
			await expect(
				acquireOwnershipSafeLock(lockPath, { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } }),
			).rejects.toThrow(/busy|locked/i);
		} finally {
			await release();
		}
	});
});
