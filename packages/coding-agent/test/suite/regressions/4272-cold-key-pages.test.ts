import { expect, it } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: cold lookup remains exact without a resident settled key catalog.
it("pages out keys and content while retaining exact asynchronous lookup", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: io.io });
	const index = new CompactContentIndex<{ body: string }>(store, () => [], 1);
	const key = "old-" + "x".repeat(80_000);
	const hold = io.hold("write", (path) => path.includes("/page-"));
	try {
		index.set(key, { body: "body".repeat(10_000) });
		await hold.entered;
		const before = index.freeze();
		expect(await index.lookup(before, key)).toBeDefined();
		hold.release();
		await store.idle();
		expect(index.pages.size).toBe(1);
		// Neither page headers nor an alternate resident membership tree retain raw keys.
		for (const page of index.pages) expect(Reflect.get(page, "keys")).toBeUndefined();
		// The in-flight pre-publication cut still owns its one pending overlay.
		expect(index.status().residentIndexNodes).toBe(1);
		expect(store.status().structuredBytes.resident).toBe(0);
		expect(index.status().residentPages).toBe(0);
		const after = index.freeze();
		try {
			expect(await index.lookup(after, key)).toBeDefined();
			expect(await index.lookup(after, key + "missing")).toBeUndefined();
			expect(await index.entries(before)).toEqual(new Map([[key, { body: "body".repeat(10_000) }]]));
			expect(await index.entries(after)).toEqual(new Map([[key, { body: "body".repeat(10_000) }]]));
			expect(index.status().residentPages).toBe(0);
			expect(index.status().peakResidentPages).toBeLessThanOrEqual(4);
		} finally {
			index.release(before);
			index.release(after);
		}
		expect(index.status().residentIndexNodes).toBe(0);
		index.patch(key, { body: "patched" });
		await store.idle();
		const patched = index.freeze();
		try {
			expect(await index.entries(patched)).toEqual(new Map([[key, { body: "patched" }]]));
		} finally {
			index.release(patched);
		}
		index.delete(key);
		await store.idle();
		const removed = index.freeze();
		expect(await index.lookup(removed, key)).toBeUndefined();
		index.release(removed);
		expect(index.status().baseRows).toBe(0);
		expect(store.status().reclaimDebtBytes).toBe(0);
	} finally {
		hold.release();
		await store.retire();
		await root.cleanup();
	}
});

it("retains a removed row's paged key until the containing page is reclaimed", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: io.io });
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 2);
	const key = "removed-" + "x".repeat(80_000);
	const hold = io.hold("write", (path) => path.includes("/page-"));
	try {
		index.set(key, { n: 1 });
		index.set("kept", { n: 2 });
		await hold.entered;
		index.delete(key);
		hold.release();
		await store.idle();
		index.set("next", { n: 3 });
		index.set("last", { n: 4 });
		await store.idle();
		expect(store.status().failures).toEqual([]);
		const cut = index.freeze();
		try {
			expect(await index.entries(cut)).toEqual(
				new Map([
					["kept", { n: 2 }],
					["last", { n: 4 }],
					["next", { n: 3 }],
				]),
			);
			expect(await index.lookup(cut, key)).toBeUndefined();
			expect(await index.lookup(cut, "next")).toBeDefined();
		} finally {
			index.release(cut);
		}
		expect(index.status().residentPages).toBe(0);
	} finally {
		hold.release();
		await store.retire();
		await root.cleanup();
	}
});
