import { renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireOwnershipSafeLock } from "../../../src/modes/rpc/ownership-safe-lock.ts";
import { ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const opened = vi.hoisted(() => ({
	watch: undefined as { path: string; resolve: () => void } | undefined,
	// Runs once, right after the first handle opened on `path` is closed.
	afterClose: undefined as { path: string; run: () => Promise<void> } | undefined,
}));

// Runs `before` and `after` around SQLite's own open of `path` (node:sqlite under vitest).
const sqliteOpen = vi.hoisted(() => ({
	around: undefined as { path: string; before: () => void; after: () => void } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (opened.watch && String(args[0]) === opened.watch.path) {
				const { resolve } = opened.watch;
				opened.watch = undefined;
				resolve();
			}
			const afterClose = opened.afterClose;
			if (afterClose && String(args[0]) === afterClose.path) {
				opened.afterClose = undefined;
				const close = handle.close.bind(handle);
				handle.close = async () => {
					await close();
					await afterClose.run();
				};
			}
			return handle;
		},
	};
});

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class DatabaseSync extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			const hook = sqliteOpen.around?.path === String(args[0]) ? sqliteOpen.around : undefined;
			if (hook) sqliteOpen.around = undefined;
			hook?.before();
			super(...args);
			hook?.after();
		}
	}
	return { ...actual, DatabaseSync };
});

function firstOpenOf(path: string): Promise<void> {
	return new Promise((resolve) => {
		opened.watch = { path, resolve };
	});
}

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.2 and 4.4, test 4 and
// the "Alias identity" row). Security contract: a repair of an invalid secret runs under the per-secret mutation lock
// `<canonical parent>/<name>.publish.lock` and re-reads the secret under it, so a contender that repaired first wins and
// a later repair never replaces its valid key. Every spelling of one physical secret maps to the same lock file.
describe.skipIf(process.platform === "win32")("serialized socket-secret repair", () => {
	const roots: string[] = [];

	afterEach(async () => {
		opened.watch = undefined;
		opened.afterClose = undefined;
		sqliteOpen.around = undefined;
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function scratch(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-repair-"));
		roots.push(root);
		return root;
	}

	/**
	 * Seeds an invalid secret, holds the publish lock as a contender would, lets `ensureSocketSecret(ensuredPath)` observe
	 * the invalid bytes, then publishes the contender's valid key as a new file and releases the lock.
	 */
	async function contenderRepairsFirst(secretPath: string, ensuredPath: string, size: number): Promise<void> {
		await writeFile(secretPath, Buffer.alloc(size, 3), { mode: 0o600 });
		const release = await acquireOwnershipSafeLock(`${secretPath}.publish.lock`);
		const observed = firstOpenOf(ensuredPath);
		const repair = ensureSocketSecret(ensuredPath);
		await observed;
		const winner = Buffer.alloc(32, 9);
		await writeFile(`${secretPath}.contender`, winner, { mode: 0o600 });
		await rename(`${secretPath}.contender`, secretPath);
		await release();
		expect(await repair).toEqual(winner);
		expect(await readFile(secretPath)).toEqual(winner);
	}

	it.each([0, 8, 31, 33])(
		"a repair of a %d-byte secret waits for the lock and returns the key a contender repaired first",
		async (size) => {
			const secretPath = join(await scratch(), "rpc.sock.secret");
			await contenderRepairsFirst(secretPath, secretPath, size);
		},
	);

	it("a repair through a symlinked parent directory waits for the canonical path's lock", async () => {
		const root = await scratch();
		const real = join(root, "real");
		await mkdir(real);
		await symlink(real, join(root, "alias"));
		await contenderRepairsFirst(join(real, "rpc.sock.secret"), join(root, "alias", "rpc.sock.secret"), 8);
	});

	it("a repair through a '..' that crosses a symlink puts its lock file in the physical parent, never the textual one", async () => {
		const root = await scratch();
		const real = join(root, "real");
		await mkdir(join(real, "sub"), { recursive: true });
		await symlink(join(real, "sub"), join(root, "link"));
		// Built as a string: path.join would resolve the '..' by text to <root>/rpc.sock.secret.
		const crossing = `${join(root, "link")}/../rpc.sock.secret`;
		await contenderRepairsFirst(join(real, "rpc.sock.secret"), crossing, 8);
		// The guard is the lock-file location: no lock file may exist in the textual parent. The wait for the contender
		// above is not the guard, since a repair under the wrong lock can still finish after the contender by timing.
		await expect(fs.access(join(root, "rpc.sock.secret.publish.lock"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("a repair with no contender replaces the invalid secret with a valid owner-only key", async () => {
		const secretPath = join(await scratch(), "rpc.sock.secret");
		await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
		const repaired = await ensureSocketSecret(secretPath);
		expect(repaired).toHaveLength(32);
		expect(await readFile(secretPath)).toEqual(repaired);
		expect((await fs.stat(secretPath)).mode & 0o777).toBe(0o600);
	});
});

// The lock file is checked through its own descriptor (no-follow where the platform has it; Windows has none), then
// SQLite reopens it by name. A lock taken on any other file would serialize nothing, so the file SQLite opened must be
// the one checked, or the repair is refused.
describe("socket-secret lock file identity", () => {
	const roots: string[] = [];

	afterEach(async () => {
		opened.afterClose = undefined;
		sqliteOpen.around = undefined;
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function seeded(): Promise<{ root: string; secretPath: string; lockPath: string }> {
		const root = await realpath(await mkdtemp(join(tmpdir(), "rpc4199-lock-identity-")));
		roots.push(root);
		const secretPath = join(root, "rpc.sock.secret");
		await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
		return { root, secretPath, lockPath: `${secretPath}.publish.lock` };
	}

	it("refuses a repair when the lock path is swapped for another file after its check", async () => {
		const { root, secretPath, lockPath } = await seeded();
		opened.afterClose = {
			path: lockPath,
			run: async () => {
				await writeFile(join(root, "impostor.lock"), "", { mode: 0o600 });
				await rename(join(root, "impostor.lock"), lockPath);
			},
		};
		await expect(ensureSocketSecret(secretPath)).rejects.toMatchObject({ code: "ELOCK_FILE_REPLACED" });
		expect(await readFile(secretPath)).toEqual(Buffer.alloc(8, 3));
	});

	// Only a descriptor check catches a swap that is undone once SQLite holds the other file; it needs a listable
	// descriptor table.
	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"refuses a repair when the lock path is swapped only while SQLite opens it",
		async () => {
			const { root, secretPath, lockPath } = await seeded();
			const parked = join(root, "parked.lock");
			const impostor = join(root, "impostor.lock");
			sqliteOpen.around = {
				path: lockPath,
				before: () => {
					writeFileSync(impostor, "", { mode: 0o600 });
					renameSync(lockPath, parked);
					renameSync(impostor, lockPath);
				},
				after: () => {
					renameSync(lockPath, impostor);
					renameSync(parked, lockPath);
				},
			};
			await expect(ensureSocketSecret(secretPath)).rejects.toMatchObject({ code: "ELOCK_FILE_REPLACED" });
			expect(await readFile(secretPath)).toEqual(Buffer.alloc(8, 3));
		},
	);
});
