import { stat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
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
		const set = index.bases.set.bind(index.bases);
		const inserts = new Set<string>();
		const fail = vi.spyOn(index.bases, "set").mockImplementation((root, key, value) => {
			if (value) inserts.add(key);
			if (inserts.size === 3) throw new CompactReadError("ownership");
			return set(root, key, value);
		});
		index.set("00064", { n: -1 });
		await store.idle();
		fail.mockRestore();
		expect(inserts.size).toBe(3);
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
// only non-JSON values and cycles: each write below makes a page for the row value `a` before the codec refuses `b`
// (`set` releases it in `ownValue`'s catch, `patch` in its own finally).
it.each(["set", "patch"])(
	"releases a partial row value on %s when the strict codec refuses a later field",
	async (kind) => {
		const root = await spoolRoot();
		const store = new CompactContentStore({ dir: root.dir });
		const index = new CompactContentIndex<{ a: unknown; b?: unknown }>(store, () => [], 1);
		try {
			index.set("row", { a: "stable" });
			await store.idle();
			const bytes = store.status().structuredBytes;
			const nodes = store.text.residentNodes;
			expect(() =>
				kind === "set"
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
	},
);

// Carry 58 (#4557 review LOW 2): a string key can no longer fail to own, so `set`'s finally error path is driven by an
// injected failure once `own(row)` and `own(key)` both returned: the payload ref (the next `store.text.own`) or the
// publish's owner (the one after, before `put` takes anything). Either way every ref `set` took (row value, key,
// payload) is released. Calls made while those values are still being owned pass through untouched.
it.each([
	["payload", 1],
	["publish", 2],
])("set releases the row value and key it owned when its %s step fails", async (_step, failingCall) => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const index = new CompactContentIndex<{ a: string }>(store, () => [], 1);
	try {
		index.set("row", { a: "stable" });
		await store.idle();
		const bytes = store.status().structuredBytes;
		const nodes = store.text.residentNodes;
		const ownValue = index.values.own.bind(index.values);
		let ownedValues = 0;
		const values = vi.spyOn(index.values, "own").mockImplementation((value) => {
			const ref = ownValue(value);
			ownedValues += 1;
			return ref;
		});
		const own = store.text.own.bind(store.text);
		const failure = new Error("injected failure after own(row) and own(key)");
		let calls = 0;
		const fail = vi.spyOn(store.text, "own").mockImplementation((refs) => {
			if (ownedValues === 2 && ++calls === failingCall) throw failure;
			return own(refs);
		});
		expect(() => index.set("k".repeat(500), { a: "new".repeat(500) })).toThrow(failure);
		fail.mockRestore();
		values.mockRestore();
		expect({ ownedValues, calls }).toEqual({ ownedValues: 2, calls: failingCall });
		await store.idle();
		expect(store.status().structuredBytes, "the row value and the key went with the failed set").toEqual(bytes);
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
