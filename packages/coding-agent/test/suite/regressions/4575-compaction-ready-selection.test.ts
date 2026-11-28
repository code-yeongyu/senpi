import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { spoolRoot } from "../compact-storage-support.ts";

it("takes a key-ordered ready snapshot that ignores later insertions (#4734)", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	try {
		const index = new CompactContentIndex<{ n: number }>(store, () => [], 128);
		for (const key of ["d", "a", "c"]) index.ready.add(key);
		const round = index.ready[Symbol.iterator]();
		expect(round.next().value).toBe("a");
		index.ready.delete("c");
		index.ready.add("b");
		expect([...round]).toEqual(["c", "d"]);
		expect(index.ready.has("c")).toBe(false);
		expect([...index.ready]).toEqual(["a", "b", "d"]);
	} finally {
		await store.retire();
		await root.cleanup();
	}
});

// senpi#4575: a compaction pass must not re-look-up every still-pending overlay key. Rows become ready in
// creation order; descending keys put the pending backlog ahead of the ready keys in key order.
it.each([512, 1024])("looks up each folded row a bounded number of times (%i rows)", async (count) => {
	const root = await spoolRoot();
	const files = new Map<string, Buffer>();
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			async writeFile(path, data) {
				files.set(path, Buffer.from(data));
			},
			async readFile(path, range) {
				const data = files.get(path);
				if (!data) throw new Error("missing backing file");
				return Buffer.from(range ? data.subarray(range.offset, range.offset + range.length) : data);
			},
			async unlink(path) {
				files.delete(path);
			},
		},
	});
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 128);
	const lookups = vi.spyOn(index.bases, "getMany");
	try {
		for (let n = 0; n < count; n++) index.set(String(count - n).padStart(5, "0"), { n });
		await store.idle();
		const keys = lookups.mock.calls.reduce((sum, [, batch]) => sum + batch.length, 0);
		// Every row is folded once; a pass that rescans the pending backlog looks up O(rows) keys per pass.
		expect(keys).toBeLessThanOrEqual(2 * count);
		expect(index.status()).toMatchObject({ baseRows: count, overrideSlots: 0 });
		const cut = index.freeze();
		try {
			const rows = await index.entries(cut);
			expect(rows.size).toBe(count);
			expect(rows.get(String(count).padStart(5, "0"))).toEqual({ n: 0 });
		} finally {
			index.release(cut);
		}
	} finally {
		lookups.mockRestore();
		await store.retire();
		await root.cleanup();
	}
});
