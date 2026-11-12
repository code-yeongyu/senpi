import { execFile, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const hooks = vi.hoisted(() => ({
	// Runs once a `node:fs/promises` lstat of a path succeeded, before its caller sees the result.
	lstatted: undefined as ((path: string) => Promise<void>) | undefined,
	// Every SQLite open (node:sqlite under vitest), with whether its path named a symbolic link when the open began.
	sqliteOpens: [] as { path: string; link: boolean }[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: (async (...args: Parameters<typeof actual.lstat>) => {
			const result = await actual.lstat(...args);
			await hooks.lstatted?.(String(args[0]));
			return result;
		}) as typeof actual.lstat,
	};
});

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class HookedDatabaseSync extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			const path = String(args[0]);
			hooks.sqliteOpens.push({ path, link: lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true });
			super(...args);
		}
	}
	return { ...actual, DatabaseSync: HookedDatabaseSync };
});

const bunAvailable = spawnSync("bun", ["--version"]).status === 0;

/**
 * Runs in Bun: takes the lock at LOCK_PATH with a `validateFile` that checks the lock file and then swaps a symbolic
 * link to TARGET in at its name, as a writer in the directory could right after the check. Prints the outcome.
 */
const BUN_SWAP_PROBE = `const { lstat, rename, symlink } = await import("node:fs/promises");
const { acquireOwnershipSafeLock } = await import(process.env.LOCK_MODULE);
const lockPath = process.env.LOCK_PATH;
const validateFile = async () => {
	const info = await lstat(lockPath, { bigint: true });
	await rename(lockPath, lockPath + ".parked");
	await symlink(process.env.TARGET, lockPath);
	return { dev: info.dev, ino: info.ino };
};
try {
	const release = await acquireOwnershipSafeLock(lockPath, { validateFile });
	await release();
	console.log(JSON.stringify({ outcome: "acquired" }));
} catch (error) {
	console.log(JSON.stringify({ outcome: "refused", code: error.code }));
}`;

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (review of senpi#6482, LOW 1).
// Security contract: SQLite reopens the validated lock file by name, and a writer in the directory can swap a symbolic
// link in at that name after the check. SQLite never follows it: bun:sqlite opens with SQLITE_OPEN_NOFOLLOW, and under
// node:sqlite, which cannot, the name is checked again right before SQLite's open. Following it would open the link's
// target, and the open of a device (a serial tty without CLOCAL) blocks the process; a FIFO stands in for it here,
// because SQLite opening one fails with an I/O error instead of the lock's own refusal.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"no-follow open of the lock file",
	() => {
		const roots: string[] = [];

		afterEach(async () => {
			hooks.lstatted = undefined;
			hooks.sqliteOpens.length = 0;
			for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
		});

		async function seeded(
			kind: "fifo" | "file",
		): Promise<{ root: string; secretPath: string; lockPath: string; target: string }> {
			const root = await realpath(await mkdtemp(join(tmpdir(), "rpc4199-nofollow-")));
			roots.push(root);
			const secretPath = join(root, "rpc.sock.secret");
			await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
			const lockPath = `${secretPath}.publish.lock`;
			await writeFile(lockPath, "", { mode: 0o600 });
			const target = join(root, `target-${kind}`);
			if (kind === "fifo") await promisify(execFile)("mkfifo", [target]);
			else await writeFile(target, "", { mode: 0o600 });
			return { root, secretPath, lockPath, target };
		}

		it.each(["fifo", "file"] as const)(
			"a symlink to a %s swapped in after the lock file's check is refused before SQLite opens the name",
			async (kind) => {
				const { root, secretPath, lockPath, target } = await seeded(kind);
				let swapped = false;
				// The lock file exists, so its check is an lstat; the swap lands right after it.
				hooks.lstatted = async (path) => {
					if (path !== lockPath || swapped) return;
					swapped = true;
					await rename(lockPath, join(root, "parked.lock"));
					await symlink(target, lockPath);
				};
				await expect(ensureSocketSecret(secretPath)).rejects.toMatchObject({ code: "ELOCK_FILE_REPLACED" });
				expect(swapped).toBe(true);
				expect(hooks.sqliteOpens.filter((open) => open.path === lockPath && open.link)).toEqual([]);
				expect(await readFile(secretPath)).toEqual(Buffer.alloc(8, 3));
			},
		);

		it.skipIf(!bunAvailable)(
			"under bun:sqlite a symlink to a fifo swapped in after the check is refused by the open, not followed",
			async () => {
				const { lockPath, target } = await seeded("fifo");
				const { stdout } = await promisify(execFile)("bun", ["-e", BUN_SWAP_PROBE], {
					env: {
						...process.env,
						LOCK_MODULE: join(import.meta.dirname, "../../../src/modes/rpc/ownership-safe-lock.ts"),
						LOCK_PATH: lockPath,
						TARGET: target,
					},
				});
				expect(JSON.parse(stdout.trim())).toEqual({ outcome: "refused", code: "ELOCK_FILE_REPLACED" });
			},
		);
	},
);
