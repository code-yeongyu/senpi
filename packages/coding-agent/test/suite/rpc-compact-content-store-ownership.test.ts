import { chmod, mkdir, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF } from "../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot } from "./compact-storage-support.ts";

// senpi#4272 (ruling 08, lead ruling on review M2): the spool directory is created 0700 by the store
// itself, a pre-existing directory is never adopted, and retirement removes only a directory this
// store created and still owns, checked without following symlinks.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const state = new CompactSessionState({
		dir: root.dir,
		io: controlledIo().io,
		spillAboveBytes: 0,
		spillTargetBytes: 0,
	});
	return { state, dir: root.dir };
}

async function spill(state: CompactSessionState, messageId: string, char: string): Promise<void> {
	state.accept({
		type: "block_start",
		messageId,
		contentIndex: 0,
		kind: "text",
		seed: char.repeat(LEAF),
		coveredCodeUnits: 0,
	});
	state.accept({ type: "message_status", messageId, persistence: "pending" });
	await state.idle();
}

async function text(state: CompactSessionState): Promise<string | undefined> {
	const cut = state.freeze();
	const view = await state.read(cut);
	state.release(cut);
	return view.messages[0]?.blocks[0]?.text;
}

describe.skipIf(process.platform === "win32")("compact spool directory ownership", () => {
	it("refuses a pre-existing 0755 directory, keeps the bytes resident, and never deletes its files", async () => {
		const { state, dir } = await setup();
		await mkdir(dir, { recursive: true });
		await chmod(dir, 0o755);
		await writeFile(join(dir, "keep.txt"), "keep");

		await spill(state, "m1", "a");
		expect(state.storageStatus()).toMatchObject({
			spillHalted: true,
			residentPayloadBytes: 65_536,
			spilledLiveBytes: 0,
			failures: [{ operation: "spool_create", path: dir, cause: expect.stringContaining("pre_existing") }],
		});
		expect(await readdir(dir)).toEqual(["keep.txt"]);
		expect((await stat(dir)).mode & 0o777).toBe(0o755);
		expect(await text(state)).toBe("a".repeat(LEAF));

		await state.retire();
		expect(await readdir(dir)).toEqual(["keep.txt"]);
	});

	it("creates the epoch directory 0700 and removes it on retirement", async () => {
		const { state, dir } = await setup();
		await spill(state, "m1", "b");
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect(state.storageStatus().spilledLiveBytes).toBe(65_536);
		await state.retire();
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses to retire a symlinked, unmarked or widened directory and leaves its contents intact", async () => {
		const tamper: [string, (dir: string) => Promise<string>][] = [
			[
				"symlink",
				async (dir) => {
					await rename(dir, `${dir}-real`);
					await symlink(`${dir}-real`, dir);
					return `${dir}-real`;
				},
			],
			[
				"marker_missing",
				async (dir) => {
					const marker = (await readdir(dir)).find((name) => !name.startsWith("leaf-"));
					await unlink(join(dir, marker ?? "missing"));
					return dir;
				},
			],
			[
				"wide_mode",
				async (dir) => {
					await chmod(dir, 0o755);
					return dir;
				},
			],
		];
		for (const [reason, apply] of tamper) {
			const { state, dir } = await setup();
			await spill(state, "m1", "c");
			const survivor = await apply(dir);
			await expect(state.retire()).rejects.toMatchObject({ name: "CompactSpoolRefusedError", reason });
			expect((await readdir(survivor)).filter((name) => name.startsWith("leaf-"))).toHaveLength(1);
		}
	});
});
