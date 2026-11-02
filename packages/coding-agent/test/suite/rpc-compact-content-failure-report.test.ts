import { readdir, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF } from "../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../src/modes/rpc/compact-session-state.ts";
import { type CompactStorageIo, nodeCompactStorageIo } from "../../src/modes/rpc/compact-storage-io.ts";
import { spoolRoot, startIdentity } from "./compact-storage-support.ts";

// senpi#4272 (#4322 delta review LOW 3): a spill write whose failure cannot even be described still
// records the failure with the bytes it keeps resident, discards the partial file, and leaves the
// leaf readable from RAM instead of stranding it pending with its file on disk.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function unprintable(): Error {
	const cause = new Error("hidden");
	Object.defineProperty(cause, "message", {
		get() {
			throw new Error("message getter failed");
		},
	});
	return cause;
}

/** Writes half of each file, then rejects with a cause whose description throws. */
const partialWriteIo: CompactStorageIo = {
	async writeFile(path, data) {
		await writeFile(path, data.subarray(0, data.byteLength / 2), { flag: "wx", mode: 0o600 });
		throw unprintable();
	},
	readFile: nodeCompactStorageIo.readFile,
	unlink: (path) => unlink(path),
};

describe("compact content store: a failure report that cannot describe its cause", () => {
	it("records the spill failure with its retained bytes, discards the partial file and keeps the leaf readable", async () => {
		const root = await spoolRoot();
		cleanups.push(root.cleanup);
		const state = new CompactSessionState({
			dir: root.dir,
			io: partialWriteIo,
			spillAboveBytes: 0,
			spillTargetBytes: 0,
		});

		state.accept({
			type: "block_start",
			...startIdentity(),
			messageId: "m1",
			contentIndex: 0,
			kind: "text",
			seed: "a".repeat(LEAF),
			coveredCodeUnits: 0,
		});
		state.accept({ type: "message_status", messageId: "m1", persistence: "pending" });
		await state.idle();

		expect(state.storageStatus()).toMatchObject({
			spillHalted: true,
			residentPayloadBytes: 65_536,
			spilledLiveBytes: 0,
			reclaimDebtBytes: 0,
			pendingIoCopyBytes: 0,
			failures: [
				{
					operation: "spill_write",
					path: expect.stringMatching(/leaf-1\.bin$/),
					cause: expect.any(String),
					retainedInMemoryBytes: 65_536,
				},
			],
		});
		expect((await readdir(root.dir)).filter((name) => name.startsWith("leaf-"))).toEqual([]);

		const cut = state.freeze();
		expect((await state.read(cut)).messages[0]?.blocks[0]?.text).toBe("a".repeat(LEAF));
		state.release(cut);
		await state.retire();
	});
});
