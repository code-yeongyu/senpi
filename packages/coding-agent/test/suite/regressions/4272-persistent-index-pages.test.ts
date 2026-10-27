import { expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactIndexTree, type IndexNode } from "../../../src/modes/rpc/compact-index-tree.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: a frozen pending overlay must retain a root, not visit every row.
it("freezes a large pending collection with bounded ownership work", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, spillAboveBytes: Number.POSITIVE_INFINITY });
	const index = new CompactContentIndex<{ leaf: number }>(store, (row) => [row.leaf], 128);
	try {
		for (let i = 0; i < 2048; i++) {
			const leaf = store.createLeaf(String(i));
			index.set(String(i).padStart(5, "0"), { leaf });
			store.adjust(leaf, -1, 0);
		}
		const adjust = vi.spyOn(store, "adjust");
		const cut = index.freeze();
		const work = adjust.mock.calls.length;
		adjust.mockRestore();
		try {
			expect(work).toBeLessThanOrEqual(32);
			index.delete("00000");
			expect((await index.entries(cut)).size).toBe(2048);
		} finally {
			index.release(cut);
		}
	} finally {
		await store.retire();
		await root.cleanup();
	}
});

it("leases a page across cut release and compaction, and refuses foreign cursors", async () => {
	const root = await spoolRoot();
	const real = controlledIo().io;
	const entered = Promise.withResolvers<string>();
	const gate = Promise.withResolvers<void>();
	let hold = false;
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			...real,
			async readFile(path) {
				if (hold && /[/\\]page-/.test(path)) {
					hold = false;
					entered.resolve(path);
					await gate.promise;
				}
				return real.readFile(path);
			},
		},
	});
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	try {
		for (let n = 0; n < 256; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		const cut = index.freeze();
		const next = (await index.page(cut)).next;
		const other = index.freeze();
		await expect(index.page(other, next)).rejects.toMatchObject({ reason: "ownership" });
		index.release(other);
		hold = true;
		const reading = index.page(cut).then(
			() => undefined,
			(error: unknown) => error,
		);
		const path = await entered.promise;
		expect(index.status().residentPages).toBe(1);
		for (let n = 0; n < 256; n++) index.delete(String(n).padStart(5, "0"));
		index.release(cut);
		await store.idle();
		expect((await stat(path)).size).toBeGreaterThan(0);
		gate.resolve();
		expect(await reading).toMatchObject({ reason: "released" });
		await store.idle();
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(index.status().residentPages).toBe(0);
	} finally {
		gate.resolve();
		await store.retire();
		await root.cleanup();
	}
}, 120_000);

it("refuses an in-memory index page when retirement precedes its promise completion", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 128);
	index.set("a", { n: 1 });
	const cut = index.freeze();
	const reading = index.page(cut).then(
		() => undefined,
		(error: unknown) => error,
	);
	const retiring = store.retire();
	try {
		expect(await reading).toMatchObject({ name: "CompactReadError", reason: "retired" });
	} finally {
		await retiring;
		index.release(cut);
		await root.cleanup();
	}
});

it("publishes one changed page through bounded paths without copying the large base", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	try {
		const count = 8192;
		// Build the base without per-insert compaction churn, then fold it once; the measured step is the single set below.
		const pause = vi.spyOn(index["compactor"], "schedule").mockImplementation(() => undefined);
		for (let n = 0; n < count; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		pause.mockRestore();
		index.maybeCompact();
		await store.idle();
		expect(
			await index.bases.get(index.base, "00512"),
			"the base is compacted before the measured step",
		).toBeDefined();
		const old = index.freeze();
		const touched = (await index.bases.get(index.base, "00512"))?.page.count ?? 0;
		const bound = 4 * touched * Math.ceil(Math.log2(count));
		expect(touched).toBeGreaterThan(0);
		expect(touched).toBeLessThanOrEqual(128);
		expect(bound).toBeLessThan(count);
		const before = index.status().allocatedIndexNodes;
		index.set("00512", { n: -1 });
		await store.idle();
		expect(index.status().allocatedIndexNodes - before).toBeLessThanOrEqual(bound);
		// Negative control: a real full clone allocates more nodes than the permitted changed paths.
		const clone = new CompactIndexTree<unknown>(() => undefined);
		let copied: IndexNode<unknown> | undefined;
		for await (const [key, value] of index.bases.entries(old.base)) {
			const next = clone.set(copied, key, value);
			clone.adjust(copied, -1, 0);
			copied = next;
		}
		expect(clone.allocatedNodes).toBeGreaterThan(bound);
		expect(clone.residentNodes).toBeGreaterThan(bound);
		clone.adjust(copied, -1, 0);
		expect(clone.residentNodes).toBe(0);
		const current = index.freeze();
		try {
			const oldRow = (await index.page(old, { cut: old, after: "00511" })).rows[0].row;
			const newRow = (await index.page(current, { cut: current, after: "00511" })).rows[0].row;
			expect(await index.values.read(oldRow.value)).toEqual({ n: 512 });
			expect(await index.values.read(newRow.value)).toEqual({ n: -1 });
		} finally {
			index.release(old);
			index.release(current);
		}
	} finally {
		await store.retire();
		await root.cleanup();
	}
}, 120_000);
