import { stat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import type { PagedRoot } from "../../../src/modes/rpc/compact-paged-tree.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: traversal I/O is per page; a failed publication preserves the entire old root.
it("reads each of three index pages once during a complete traversal", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 128);
	try {
		for (let n = 0; n < 384; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		expect(index.pages.size).toBe(3);
		const read = vi.spyOn(index, "readPage");
		const cut = index.freeze();
		try {
			expect((await index.entries(cut)).size).toBe(384);
			expect(read.mock.calls.length).toBe(index.pages.size);
			expect(index.status().residentPages).toBe(0);
			expect(index.peakResidentPages).toBeLessThanOrEqual(2);
		} finally {
			index.release(cut);
		}
	} finally {
		await store.retire();
		await root.cleanup();
	}
});

it("rolls back a mid-publish ownership failure and runs the next compaction", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	try {
		for (let n = 0; n < 256; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		const base = index.base;
		const pages = [...index.pages];
		// The third node the round builds fails after two were made: a publication half way through its new paths.
		const tree = index.bases as unknown as { make(node: object): Promise<PagedRoot> };
		const make = tree.make.bind(tree);
		let made = 0;
		const fail = vi.spyOn(tree, "make").mockImplementation(async (node) => {
			if (++made === 3) throw new CompactReadError("ownership");
			return make(node);
		});
		index.set("00064", { n: -1 });
		await store.idle();
		fail.mockRestore();
		expect(made).toBe(3);
		expect(store.status().failures).toEqual(
			expect.arrayContaining([expect.objectContaining({ operation: "page_write" })]),
		);
		expect(index.base).toBe(base);
		expect([...index.pages]).toEqual(pages);
		for (const page of pages) expect((await stat(page.path)).size).toBe(page.bytes);
		const cut = index.freeze();
		try {
			const rows = await index.entries(cut);
			expect(rows.size).toBe(256);
			expect(rows.get("00064")).toEqual({ n: -1 });
		} finally {
			index.release(cut);
		}
		index.maybeCompact();
		await store.idle();
		expect(index.status()).toMatchObject({ baseRows: 256, overrideSlots: 0, residentPages: 0 });
		const after = index.freeze();
		try {
			expect((await index.entries(after)).get("00064")).toEqual({ n: -1 });
		} finally {
			index.release(after);
		}
		for (let n = 0; n < 256; n++) index.delete(String(n).padStart(5, "0"));
		await store.idle();
		expect(index.status()).toMatchObject({ baseRows: 0, overrideSlots: 0, residentIndexNodes: 0 });
		expect(store.status()).toMatchObject({
			structuredBytes: { resident: 0, spilled: 0, pinned: 0 },
			reclaimDebtBytes: 0,
		});
		expect(store.text.residentNodes).toBe(0);
	} finally {
		await store.retire();
		await root.cleanup();
	}
});

// Since S03b-4 (S10-Q2, RULING-59 A) a string of any length is a legal value and index key, so the strict codec refuses
// only non-JSON values and cycles: each write below makes a page for `a` before the codec refuses `b`.
it.each(["key", "patch"])("releases partial %s writes when the strict codec refuses", async (kind) => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const index = new CompactContentIndex<{ a: unknown; b?: unknown }>(store, () => [], 1);
	try {
		index.set("row", { a: "stable" });
		await store.idle();
		const bytes = store.status().structuredBytes;
		const nodes = store.text.residentNodes;
		expect(() =>
			kind === "key"
				? index.set("new", { a: "new".repeat(500), b: undefined })
				: index.patch("row", { a: "new".repeat(500), b: undefined }),
		).toThrowError(expect.objectContaining({ name: "CompactWriteError" }));
		await store.idle();
		expect(store.status().structuredBytes).toEqual(bytes);
		expect(store.text.residentNodes).toBe(nodes);
		const cut = index.freeze();
		try {
			expect(await index.entries(cut)).toEqual(new Map([["row", { a: "stable" }]]));
		} finally {
			index.release(cut);
		}
	} finally {
		await store.retire();
		await root.cleanup();
	}
});
