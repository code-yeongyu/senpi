import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CompactContentStore, type LeafId } from "../../../src/modes/rpc/compact-content-store.ts";
import type { CompactFileRange } from "../../../src/modes/rpc/compact-storage-io.ts";
import { controlledIo, type IoHold, spoolRoot } from "../compact-storage-support.ts";

// Eight 128-byte leaves in one 1,024-byte segment; releasing five leaves 3, 4 and 7 live and rewrites it.
const RELEASED = [0, 1, 2, 5, 6];

async function segmentStore() {
	const root = await spoolRoot();
	const control = controlledIo();
	const reads: { path: string; range: CompactFileRange | undefined }[] = [];
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			...control.io,
			readFile(path, range) {
				reads.push({ path, range });
				return control.io.readFile(path, range);
			},
		},
	});
	const ids: LeafId[] = Array.from({ length: 8 }, (_, n) => store.createLeaf(String(n).repeat(64), true));
	await store.flushLeaves(ids);
	await store.idle();
	const [name] = (await readdir(root.dir)).filter((file) => file.startsWith("value-"));
	return { root, control, reads, store, ids, path: join(root.dir, name) };
}

// senpi#4272 / SP1 review LOW 1: a rewrite copies only the live bytes, and that copy shows in status().
it("reads only the live ranges of a mostly dead segment and accounts the copy while it is rewritten", async () => {
	const { root, control, reads, store, ids, path } = await segmentStore();
	let held: IoHold | undefined;
	try {
		held = control.hold("write", (file) => file !== path);
		for (const n of RELEASED) store.adjust(ids[n], -1, 0);
		await held.entered;
		// Live leaves 3+4 are one adjacent run and leaf 7 another: 384 bytes read, not the 1,024-byte file.
		expect(reads.filter((read) => read.path === path).map((read) => read.range)).toEqual([
			{ offset: 384, length: 256 },
			{ offset: 896, length: 128 },
		]);
		// The live bytes read back plus the new segment's buffer are both in memory during the write.
		expect(store.status().pendingIoCopyBytes).toBe(2 * 384);
		held.release();
		await store.idle();
		expect(store.status().pendingIoCopyBytes).toBe(0);
		for (const n of [3, 4, 7]) expect(await store.readLeaf(ids[n])).toBe(String(n).repeat(64));
	} finally {
		held?.release();
		await store.retire();
		await root.cleanup();
	}
});

// senpi#4272 / SP1 review LOW 2: an orderly retire() during a rewrite's read is an abort, not a failure.
it("records no failure when the store retires while a rewrite is reading", async () => {
	const { root, control, store, ids, path } = await segmentStore();
	let held: IoHold | undefined;
	try {
		held = control.hold("read", (file) => file === path);
		for (const n of RELEASED) store.adjust(ids[n], -1, 0);
		await held.entered;
		const retiring = store.retire();
		held.release();
		await retiring;
		expect(store.status().failures).toEqual([]);
	} finally {
		held?.release();
		await store.retire();
		await root.cleanup();
	}
});
