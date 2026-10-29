import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore, type LeafId } from "../../../src/modes/rpc/compact-content-store.ts";
import { controlledIo, type IoHold, spoolRoot } from "../compact-storage-support.ts";

const segmentFiles = async (dir: string) => {
	const names = (await readdir(dir)).filter((name) => name.startsWith("value-"));
	return Promise.all(names.map(async (name) => ({ name, bytes: (await stat(join(dir, name))).size })));
};

// senpi#4272 / SP1: one segment per flush; a segment goes with its last live node and its last read.
it("keeps a rewritten segment until its in-flight read finishes, then deletes it with its last node", async () => {
	const root = await spoolRoot();
	const control = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: control.io });
	let held: IoHold | undefined;
	try {
		const ids = ["a", "b", "c", "d"].map((text) => store.createLeaf(text.repeat(100), true));
		await store.flushLeaves(ids);
		await store.idle();
		const [first] = await segmentFiles(root.dir);
		expect(first.bytes).toBe(800);
		held = control.hold("read");
		const reading = store.readLeaf(ids[0]);
		const path = await held.entered;
		for (const id of ids.slice(1)) store.adjust(id, -1, 0);
		await store.idle();
		const files = await segmentFiles(root.dir);
		expect(files.map((file) => file.bytes).sort((x, y) => x - y)).toEqual([200, 800]);
		expect(files.find((file) => file.bytes === 800)?.name).toBe(first.name);
		held.release();
		expect(await reading).toBe("a".repeat(100));
		await store.idle();
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await store.readLeaf(ids[0])).toBe("a".repeat(100));
		store.adjust(ids[0], -1, 0);
		await store.idle();
		expect(await segmentFiles(root.dir)).toEqual([]);
		expect(store.status()).toMatchObject({ structuredBytes: { resident: 0, spilled: 0 }, reclaimDebtBytes: 0 });
	} finally {
		held?.release();
		await store.retire();
		await root.cleanup();
	}
});

it("rewrites each segment once when its live bytes fall below half, so dead bytes never exceed live bytes", async () => {
	const root = await spoolRoot();
	const control = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: control.io });
	const writes = vi.spyOn(store, "writeFile");
	try {
		const ids: LeafId[] = Array.from({ length: 8 }, (_, n) => store.createLeaf(String(n).repeat(64), true));
		await store.flushLeaves(ids);
		await store.idle();
		// 8 -> 3 live leaves rewrites the first segment, 3 -> 1 its successor; the last release deletes the file.
		const segmentWrites = [1, 1, 1, 1, 2, 2, 3, 3];
		for (const [n, id] of ids.entries()) {
			store.adjust(id, -1, 0);
			await store.idle();
			const onDisk = (await segmentFiles(root.dir)).reduce((sum, file) => sum + file.bytes, 0);
			const live = store.status().structuredBytes.spilled;
			expect(live, `after releasing ${n + 1}`).toBe((7 - n) * 128);
			expect(onDisk - live, `dead bytes after releasing ${n + 1}`).toBeLessThanOrEqual(live);
			expect(writes, `segment writes after releasing ${n + 1}`).toHaveBeenCalledTimes(segmentWrites[n]);
			if (n < 7) expect(await store.readLeaf(ids[7])).toBe("7".repeat(64));
		}
		expect(await segmentFiles(root.dir)).toEqual([]);
	} finally {
		await store.retire();
		await root.cleanup();
	}
});

it("keeps a round's nodes in RAM and the previous base readable when the segment write fails", async () => {
	const root = await spoolRoot();
	const control = controlledIo();
	let failing = false;
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			...control.io,
			async writeFile(path, data) {
				if (failing && /[/\\]value-/.test(path)) throw new Error("ENOSPC: segment");
				return control.io.writeFile(path, data);
			},
		},
	});
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	const leaves: ReadonlyMap<LeafId, { state: string }> = store["leaves"];
	try {
		for (let n = 0; n < 256; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		const base = index.base;
		const pages = [...index.pages];
		const flushLeaves = store.flushLeaves.bind(store);
		const kept: boolean[] = [];
		vi.spyOn(store, "flushLeaves").mockImplementation(async (ids) => {
			const batch = [...ids].filter((id) => leaves.has(id));
			failing = batch.length > 1;
			await flushLeaves(batch);
			if (failing) kept.push(...batch.map((id) => leaves.get(id)?.state === "ram"));
		});
		index.set("00064", { n: -1 });
		index.set("00300", { n: 300 });
		await store.idle();
		expect(kept.length).toBeGreaterThan(1);
		expect(kept.every(Boolean)).toBe(true);
		expect(store.status()).toMatchObject({ spillHalted: true });
		expect(store.status().failures).toEqual(
			expect.arrayContaining([expect.objectContaining({ operation: "value_write" })]),
		);
		expect(index.base).toBe(base);
		expect([...index.pages]).toEqual(pages);
		const cut = index.freeze();
		try {
			const rows = await index.entries(cut);
			expect(rows.size).toBe(257);
			expect(rows.get("00064")).toEqual({ n: -1 });
			expect(rows.get("00300")).toEqual({ n: 300 });
			expect(rows.get("00255")).toEqual({ n: 255 });
		} finally {
			index.release(cut);
		}
	} finally {
		vi.restoreAllMocks();
		await store.retire();
		await root.cleanup();
	}
});
