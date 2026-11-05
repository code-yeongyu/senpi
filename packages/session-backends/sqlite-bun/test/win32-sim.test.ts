// senpi#4740 (QX1.win.S03a): under the win32 profile the store opens, commits, recovers and closes with the POSIX
// results. No Windows host: the profile simulates drive-letter `\` paths, case-insensitive names and EBUSY/EPERM.
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { StoreWrite } from "@earendil-works/pi-agent-core/conformance";
import { type Win32OpenFileErrorCode, Win32SimFs } from "@earendil-works/pi-agent-core/testing/win32-sim";
import { afterEach, describe, expect, it } from "vitest";
import { type BunSqliteMedia, createBunSqliteMedia, type MediaFileSystem } from "../src/index.ts";

const roots: string[] = [];
async function scratchRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "sqlite-bun-win32-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The store's filesystem seam on P0-03i's shared win32 profile; a held store file is an open file in the profile. */
function createWin32SimFileSystem(root: string, deleteOpenFileError: Win32OpenFileErrorCode): MediaFileSystem {
	const sim = new Win32SimFs({ root, deleteOpenFileError });
	return {
		join: (...segments) => path.win32.join(...segments),
		resolve: (target) => sim.resolve(target),
		mkdir: (target) => sim.mkdir(target),
		rm: (target) => sim.rm(target),
		async hold(target) {
			const file = await sim.open(target);
			return { close: () => file.close() };
		},
	};
}

const append = (id: string): StoreWrite => ({ op: "append", id, kind: "entry", data: { id } });
const put = (key: string, data: number): StoreWrite => ({ op: "put", key, data });

class Killed extends Error {}

/** Open, commit, kill an instance after its batch is durable, recover on a fresh open, commit again, delete. */
async function lifecycle(media: BunSqliteMedia, alias: (medium: string) => string) {
	const medium = await media.createMedium();
	const first = await media.open(medium);
	await first.claim(0, 1);
	const committed = [await first.commit(1, [append("r1"), put("doc", 1)], () => {})];

	const killed = await media.open(alias(medium), {
		onWritePoint: (point) => {
			if (point.op === "commit" && point.at === "durable") throw new Killed();
		},
	});
	const kill = await killed.commit(1, [append("r2"), put("doc", 2)], () => {}).catch((error: unknown) => error);

	const recovered = await media.open(alias(medium));
	const afterKill = await recovered.exportSnapshot();
	committed.push(await recovered.commit(1, [append("r3"), { op: "delete", key: "doc" }], () => {}));
	const final = await (await media.open(medium)).exportSnapshot();

	await media.deleteMedium(alias(medium));
	return { medium, killedWith: kill instanceof Killed, committed, afterKill, final };
}

async function posixRun() {
	const root = await scratchRoot();
	const media = createBunSqliteMedia(root);
	const run = await lifecycle(media, (medium) => medium);
	const gone = await stat(run.medium).then(
		() => false,
		() => true,
	);
	await media.close();
	return { ...run, gone };
}

const flipCase = (win32Path: string): string =>
	win32Path.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));

describe("the Bun SQLite store under the win32 profile", () => {
	for (const deleteOpenFileError of ["EBUSY", "EPERM"] as const) {
		it(`opens, commits, recovers and closes with the POSIX results (${deleteOpenFileError} on deleting an open file)`, async () => {
			const posix = await posixRun();
			const fs = createWin32SimFileSystem(await scratchRoot(), deleteOpenFileError);
			const media = createBunSqliteMedia("C:\\Senpi\\Media", fs);
			const win32 = await lifecycle(media, flipCase);

			expect(win32.medium).toMatch(/^C:\\Senpi\\Media\\[0-9a-f-]{36}$/);
			expect(path.win32.isAbsolute(win32.medium)).toBe(true);
			expect(posix.killedWith).toBe(true);
			expect(posix.gone).toBe(true);
			expect({ ...win32, medium: undefined }).toEqual({ ...posix, medium: undefined, gone: undefined });
			await expect(fs.resolve(win32.medium).then(stat)).rejects.toMatchObject({ code: "ENOENT" });
			await media.close();
		});
	}

	it("refuses to delete a medium whose store file is still held open, as Windows does", async () => {
		const fs = createWin32SimFileSystem(await scratchRoot(), "EBUSY");
		await fs.mkdir("C:\\Senpi\\M");
		await writeFile(await fs.resolve("C:\\Senpi\\M\\store.sqlite"), "");
		const held = await fs.hold("C:\\Senpi\\M\\store.sqlite");
		await expect(fs.rm("c:\\senpi\\m")).rejects.toMatchObject({ code: "EBUSY" });
		await held.close();
		await fs.rm("c:\\senpi\\m");
		await expect(fs.resolve("C:\\Senpi\\M").then(stat)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("takes only drive-letter paths, so a POSIX-joined medium path cannot reach the store", async () => {
		const fs = createWin32SimFileSystem(await scratchRoot(), "EBUSY");
		await expect(fs.resolve("/Senpi/Media/x")).rejects.toThrow("expected a drive-letter path");
	});
});
