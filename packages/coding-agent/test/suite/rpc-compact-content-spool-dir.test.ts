import { open, readdir, rm, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF } from "../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../src/modes/rpc/compact-session-state.ts";
import { createSpoolDir } from "../../src/modes/rpc/compact-spool-dir.ts";
import { controlledIo, spoolRoot, startIdentity } from "./compact-storage-support.ts";

const fsFault = vi.hoisted(() => ({
	markerWrite: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			const [path] = args;
			if (fsFault.markerWrite && String(path).endsWith(".compact-spool-owner"))
				return fsFault.markerWrite(String(path));
			return actual.writeFile(...args);
		},
	};
});

// senpi#4272 (#4322 delta review LOWs 1-2): a spool directory whose ownership marker could not be
// written is removed again with a typed failure, so a restart creates it fresh instead of refusing
// it as pre-existing; retiring a store whose directory is already gone settles without an error.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	fsFault.markerWrite = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function root(): Promise<string> {
	const spool = await spoolRoot();
	cleanups.push(spool.cleanup);
	return spool.dir;
}

function store(dir: string): CompactSessionState {
	return new CompactSessionState({ dir, io: controlledIo().io, spillAboveBytes: 0, spillTargetBytes: 0 });
}

async function spill(state: CompactSessionState, char: string): Promise<void> {
	const messageId = `m-${char}`;
	state.accept({
		type: "block_start",
		...startIdentity(),
		messageId,
		contentIndex: 0,
		kind: "text",
		seed: char.repeat(LEAF),
		coveredCodeUnits: 0,
	});
	state.accept({ type: "message_status", messageId, persistence: "pending" });
	await state.idle();
}

const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

describe.skipIf(process.platform === "win32")("compact spool directory: marker write failure and retirement", () => {
	it("removes the new directory when the marker cannot be created, so a restart creates it fresh", async () => {
		const dir = await root();
		fsFault.markerWrite = async () => {
			throw enospc();
		};
		await expect(createSpoolDir(dir)).rejects.toMatchObject({
			name: "CompactSpoolRefusedError",
			reason: "marker_write_failed",
		});
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });

		fsFault.markerWrite = undefined;
		await expect(createSpoolDir(dir)).resolves.toEqual(expect.any(String));
	});

	it("removes a partially written marker it created and reports the typed failure with the retained bytes", async () => {
		const dir = await root();
		fsFault.markerWrite = async (path) => {
			await (await open(path, "wx", 0o600)).close();
			throw enospc();
		};
		const first = store(dir);
		await spill(first, "a");
		expect(first.storageStatus()).toMatchObject({
			spillHalted: true,
			residentPayloadBytes: 65_536,
			failures: [
				{
					operation: "spool_create",
					path: dir,
					cause: expect.stringMatching(/marker_write_failed.*ENOSPC/),
					retainedInMemoryBytes: 65_536,
				},
			],
		});
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });

		fsFault.markerWrite = undefined;
		const restarted = store(dir);
		await spill(restarted, "b");
		expect(restarted.storageStatus()).toMatchObject({ spillHalted: false, spilledLiveBytes: 65_536, failures: [] });
		await restarted.retire();
	});

	it("settles retirement as a no-op when the epoch directory is already gone", async () => {
		const dir = await root();
		const state = store(dir);
		await spill(state, "c");
		expect((await readdir(dir)).some((name) => name.startsWith("leaf-"))).toBe(true);
		await rm(dir, { recursive: true, force: true });

		await expect(state.retire()).resolves.toBeUndefined();
	});
});
