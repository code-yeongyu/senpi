import { execFileSync } from "node:child_process";
import { fstatSync, readdirSync } from "node:fs";
import { link, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const hooks = vi.hoisted(() => ({
	// Runs before each `node:fs/promises` open, with its path.
	opening: undefined as ((path: string) => Promise<void>) | undefined,
	// Runs after each `node:fs/promises` link succeeded, with its new path.
	linked: undefined as ((newPath: string) => Promise<void>) | undefined,
	// Runs right before a SQLite connection of this process commits (the lock holder's release).
	beforeCommit: undefined as (() => void) | undefined,
	// Each commit of this process: whether it succeeded.
	commits: [] as ("committed" | "failed")[],
	// The identity of every file a `node:fs/promises` open got.
	openedFiles: [] as { dev: bigint; ino: bigint }[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			await hooks.opening?.(String(args[0]));
			const handle = await actual.open(...args);
			const { dev, ino } = await handle.stat({ bigint: true });
			hooks.openedFiles.push({ dev, ino });
			return handle;
		},
		link: async (...args: Parameters<typeof actual.link>) => {
			await actual.link(...args);
			await hooks.linked?.(String(args[1]));
		},
	};
});

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class HookedDatabaseSync extends actual.DatabaseSync {
		override exec(sql: string): void {
			if (sql !== "COMMIT;") return super.exec(sql);
			hooks.beforeCommit?.();
			try {
				super.exec(sql);
				hooks.commits.push("committed");
			} catch (error: unknown) {
				hooks.commits.push("failed");
				throw error;
			}
		}
	}
	return { ...actual, DatabaseSync: HookedDatabaseSync };
});

const PROBE = `const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1]);
try { database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); database.exec("ROLLBACK;"); console.log("acquired"); }
catch { console.log("busy"); }
finally { database.close(); }`;

/** Another process's attempt to take the SQLite lock on `lockPath` at once: "acquired" or "busy". */
function childLockAttempt(lockPath: string): string {
	return execFileSync(process.execPath, ["--no-warnings", "-e", PROBE, lockPath], { encoding: "utf8" }).trim();
}

/** The descriptors of this process open on the file `identity` names. */
function descriptorsOf(identity: { dev: bigint; ino: bigint }): number[] {
	const directory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
	return readdirSync(directory)
		.map(Number)
		.filter((fd) => {
			try {
				const info = fstatSync(fd, { bigint: true });
				return info.dev === identity.dev && info.ino === identity.ino;
			} catch {
				return false;
			}
		});
}

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 and senpi#6478 (review of
// senpi#6482, LOW 2). Security contract: closing any descriptor of a file drops all of this process's POSIX locks on it,
// so no open of another name in this process (the secret's reads, the staging file, the directory sync) closes a
// descriptor of a lock file this process holds, even when a writer in the directory makes that name a hard link to it:
// another process still cannot take the lock while it is held, and the holder's release commits.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"publish lock under name aliases",
	() => {
		const roots: string[] = [];

		afterEach(async () => {
			hooks.opening = undefined;
			hooks.linked = undefined;
			hooks.beforeCommit = undefined;
			hooks.commits.length = 0;
			hooks.openedFiles.length = 0;
			for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
		});

		async function seeded(): Promise<{ root: string; secretPath: string; lockPath: string }> {
			const root = await realpath(await mkdtemp(join(tmpdir(), "rpc4199-lock-alias-")));
			roots.push(root);
			const secretPath = join(root, "rpc.sock.secret");
			const lockPath = `${secretPath}.publish.lock`;
			await writeFile(lockPath, "", { mode: 0o600 });
			return { root, secretPath, lockPath };
		}

		/** Probes the lock at `lockPath` from another process right before the holder releases it. */
		function probeBeforeRelease(lockPath: string): string[] {
			const probes: string[] = [];
			hooks.beforeCommit = () => probes.push(childLockAttempt(lockPath));
			return probes;
		}

		it("a secret name hard-linked to the lock file is refused under the lock without dropping it", async () => {
			const { secretPath, lockPath } = await seeded();
			await link(lockPath, secretPath);
			const probes = probeBeforeRelease(lockPath);
			const outcome = await ensureSocketSecret(secretPath).then(
				() => "returned",
				(error: unknown) => error,
			);
			expect(probes).toEqual(["busy"]);
			expect(hooks.commits).toEqual(["committed"]);
			expect(outcome).toMatchObject({ code: "ELOCK_FILE_ALIAS" });
			expect(childLockAttempt(lockPath)).toBe("acquired");
			expect((await stat(secretPath)).ino).toBe((await stat(lockPath)).ino);
		});

		it("a secret name swapped for a hard link to the lock file while it is held is never closed under the lock", async () => {
			const { root, secretPath, lockPath } = await seeded();
			await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
			const lockFile = await stat(lockPath, { bigint: true });
			let opens = 0;
			// The first open of the secret is the hint read before the lock; the second is the read under it.
			hooks.opening = async (path) => {
				if (path !== secretPath || ++opens !== 2) return;
				await link(lockPath, join(root, "alias"));
				await rename(join(root, "alias"), secretPath);
			};
			const probes = probeBeforeRelease(lockPath);
			const outcome = await ensureSocketSecret(secretPath).then(
				() => "returned",
				(error: unknown) => error,
			);
			expect(opens).toBe(2);
			expect(probes).toEqual(["busy"]);
			expect(hooks.commits).toEqual(["committed"]);
			expect(outcome).toMatchObject({ code: "ELOCK_FILE_ALIAS" });
			expect(childLockAttempt(lockPath)).toBe("acquired");
			// The descriptor the read got on the lock file was kept open under the lock and closed after its release.
			expect(descriptorsOf(lockFile)).toEqual([]);
		});

		// SQLite's commit itself fails once the lock file's directory is moved (it deletes the journal by name), so this case
		// checks the lock and the opens, not the release.
		it("a directory name swapped for a hard link to the lock file is not opened by the directory sync", async () => {
			const { root, secretPath, lockPath } = await seeded();
			const lockFile = await stat(lockPath, { bigint: true });
			const moved = `${root}.moved`;
			roots.push(moved);
			const movedLock = join(moved, "rpc.sock.secret.publish.lock");
			// Right after the secret is published, a writer in the parent directory swaps the secret's directory for a hard
			// link to the lock file, which the holder keeps locked under its new name.
			hooks.linked = async (newPath) => {
				if (newPath !== secretPath) return;
				hooks.linked = undefined;
				await rename(root, moved);
				await link(movedLock, root);
			};
			const probes = probeBeforeRelease(movedLock);
			await expect(ensureSocketSecret(secretPath)).rejects.toThrow();
			expect(probes).toEqual(["busy"]);
			expect(hooks.openedFiles.filter((file) => file.dev === lockFile.dev && file.ino === lockFile.ino)).toEqual([]);
			expect(childLockAttempt(movedLock)).toBe("acquired");
		});
	},
);
