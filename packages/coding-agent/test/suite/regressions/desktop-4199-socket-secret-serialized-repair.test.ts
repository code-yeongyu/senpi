import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireOwnershipSafeLock } from "../../../src/modes/rpc/ownership-safe-lock.ts";
import { ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const opened = vi.hoisted(() => ({ watch: undefined as { path: string; resolve: () => void } | undefined }));

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
			return handle;
		},
	};
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

	it("a repair through a '..' that crosses a symlink locks the physical parent, not the textual one", async () => {
		const root = await scratch();
		const real = join(root, "real");
		await mkdir(join(real, "sub"), { recursive: true });
		await symlink(join(real, "sub"), join(root, "link"));
		// Built as a string: path.join would resolve the '..' by text to <root>/rpc.sock.secret.
		const crossing = `${join(root, "link")}/../rpc.sock.secret`;
		await contenderRepairsFirst(join(real, "rpc.sock.secret"), crossing, 8);
		await expect(fs.access(join(root, "rpc.sock.secret.publish.lock"))).rejects.toThrow();
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
