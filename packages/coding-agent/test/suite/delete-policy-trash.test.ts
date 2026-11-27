// omo#11072: deletes go to a restorable trash, never silently to a permanent delete or a cross-device copy.
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listTrash, restoreTrash, trashPath } from "../../src/core/extensions/builtin/delete-policy/trash.ts";
import { removeTrashSandboxes, readTree, trashSandbox, writeTree } from "./delete-policy-fixtures.ts";

afterEach(removeTrashSandboxes);

function exdev(): Promise<void> {
	return Promise.reject(Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }));
}

describe.skipIf(process.platform === "win32")("freedesktop trash", () => {
	it("round-trips trash -> list -> restore with identical bytes and a spec .trashinfo", async () => {
		const box = await trashSandbox();
		const worktree = join(box.work, "my worktree");
		const files = { "README.md": "hello", "src/a.ts": "export const a = 1;\n", ".git": "gitdir: elsewhere\n" };
		await writeTree(worktree, files);

		const entry = await trashPath(box.scope(), worktree, "finished");

		await expect(readdir(box.work)).resolves.toEqual([]);
		expect(entry).toMatchObject({
			backend: "freedesktop",
			originalPath: worktree,
			trashedPath: join(box.trashDir, "files", "my worktree"),
			infoPath: join(box.trashDir, "info", "my worktree.trashinfo"),
			deletedAt: box.clock.now,
			sessionId: "session-test",
			reason: "finished",
		});
		expect(entry.bytes).toBeGreaterThanOrEqual(5 + 20 + 18);
		const info = await readFile(join(box.trashDir, "info", "my worktree.trashinfo"), "utf8");
		const lines = info.split("\n");
		expect(lines[0]).toBe("[Trash Info]");
		expect(lines[1]).toBe(`Path=${worktree.split("/").map(encodeURIComponent).join("/")}`);
		expect(lines[1]).toContain("my%20worktree");
		expect(lines[2]).toMatch(/^DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		await expect(readTree(entry.trashedPath)).resolves.toEqual(files);
		await expect(listTrash(box.scope())).resolves.toEqual([entry]);

		await expect(restoreTrash(box.scope({ actor: "user" }), entry.id)).resolves.toEqual(entry);

		await expect(readTree(worktree)).resolves.toEqual(files);
		await expect(readdir(join(box.trashDir, "files"))).resolves.toEqual([]);
		await expect(readdir(join(box.trashDir, "info"))).resolves.toEqual([]);
		await expect(listTrash(box.scope())).resolves.toEqual([]);
	});

	it("gives same-named items distinct trash names and restores each to its own origin", async () => {
		const box = await trashSandbox();
		const first = join(box.work, "a", "build");
		const second = join(box.work, "b", "build");
		await writeTree(first, { "one.txt": "1" });
		await writeTree(second, { "two.txt": "2" });

		const a = await trashPath(box.scope(), first, "x");
		const b = await trashPath(box.scope(), second, "x");

		expect([a.trashedPath, b.trashedPath]).toEqual([
			join(box.trashDir, "files", "build"),
			join(box.trashDir, "files", "build.2"),
		]);
		await expect(readdir(join(box.trashDir, "info"))).resolves.toEqual(
			expect.arrayContaining(["build.trashinfo", "build.2.trashinfo"]),
		);
		await restoreTrash(box.scope(), b.id);
		await restoreTrash(box.scope(), a.id);
		await expect(readTree(first)).resolves.toEqual({ "one.txt": "1" });
		await expect(readTree(second)).resolves.toEqual({ "two.txt": "2" });
	});

	it("refuses to restore over a path that exists again and keeps the entry", async () => {
		const box = await trashSandbox();
		const target = join(box.work, "data");
		await writeTree(target, { "old.txt": "old" });
		const entry = await trashPath(box.scope(), target, "x");
		await writeTree(target, { "new.txt": "new" });

		await expect(restoreTrash(box.scope(), entry.id)).rejects.toMatchObject({ code: "restore_collision" });

		await expect(readTree(target)).resolves.toEqual({ "new.txt": "new" });
		await expect(listTrash(box.scope())).resolves.toEqual([entry]);
		await expect(readTree(entry.trashedPath)).resolves.toEqual({ "old.txt": "old" });
	});

	it("refuses a cross-device move, leaving the target, the trash and the index untouched", async () => {
		const box = await trashSandbox();
		const target = join(box.work, "elsewhere");
		await writeTree(target, { "keep.txt": "keep" });

		await expect(trashPath(box.scope({ rename: exdev }), target, "x")).rejects.toMatchObject({
			code: "cross_device",
		});

		await expect(readTree(target)).resolves.toEqual({ "keep.txt": "keep" });
		await expect(readdir(join(box.trashDir, "files"))).resolves.toEqual([]);
		await expect(readdir(join(box.trashDir, "info"))).resolves.toEqual([]);
		await expect(listTrash(box.scope())).resolves.toEqual([]);
	});

	it("refuses a missing path, the trash itself, and a directory that contains the trash", async () => {
		const box = await trashSandbox();
		await mkdir(join(box.trashDir, "files"), { recursive: true });

		await expect(trashPath(box.scope(), join(box.work, "nope"), "x")).rejects.toMatchObject({ code: "not_found" });
		await expect(trashPath(box.scope(), box.trashDir, "x")).rejects.toMatchObject({ code: "inside_trash" });
		await expect(trashPath(box.scope(), join(box.trashDir, "files"), "x")).rejects.toMatchObject({
			code: "inside_trash",
		});
		await expect(trashPath(box.scope(), box.home, "x")).rejects.toMatchObject({ code: "inside_trash" });
		await expect(readdir(box.home)).resolves.toEqual(expect.arrayContaining(["work", ".local"]));
	});

	it.runIf(process.platform === "linux")("refuses a mount point before any move is attempted", async () => {
		const box = await trashSandbox();
		const moves: string[] = [];
		const record = async (from: string): Promise<void> => {
			moves.push(from);
		};

		await expect(trashPath(box.scope({ rename: record }), "/proc", "x")).rejects.toMatchObject({
			code: "mount_point",
		});
		expect(moves).toEqual([]);
	});
});

describe.skipIf(process.platform === "win32")("macOS default backend (senpi#7578)", () => {
	it("moves with a same-volume rename into the freedesktop-layout trash, without calling the OS Trash", async () => {
		const box = await trashSandbox();
		const worktree = join(box.work, "done");
		await writeTree(worktree, { "a.txt": "a" });

		const entry = await trashPath(box.scope({ platform: "darwin" }), worktree, "finished");

		expect(entry.backend).toBe("freedesktop");
		expect(entry.trashedPath).toBe(join(box.trashDir, "files", "done"));
		await expect(readTree(entry.trashedPath)).resolves.toEqual({ "a.txt": "a" });
		await restoreTrash(box.scope({ platform: "darwin" }), entry.id);
		await expect(readTree(worktree)).resolves.toEqual({ "a.txt": "a" });
	});
});
