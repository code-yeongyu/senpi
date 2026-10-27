import { expect, it } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: relocation must own values before the producer can mutate its input.
it("owns nested values across a held compaction and preserves a newer patch", async () => {
	const root = await spoolRoot();
	const control = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: control.io, spillAboveBytes: 0, spillTargetBytes: 0 });
	const index = new CompactContentIndex<{ nested: { n: number }; status: string }>(store, () => [], 1);
	const row = { nested: { n: 1 }, status: "pending" };
	const write = control.hold("write");
	try {
		index.set("a", row);
		const before = index.freeze();
		await write.entered;
		row.nested.n = 99;
		index.patch("a", { status: "appended" });
		write.release();
		await store.idle();
		const after = index.freeze();
		try {
			expect((await index.entries(before)).get("a")).toEqual({ nested: { n: 1 }, status: "pending" });
			expect((await index.entries(after)).get("a")).toEqual({ nested: { n: 1 }, status: "appended" });
		} finally {
			index.release(before);
			index.release(after);
		}
	} finally {
		write.release();
		await store.retire();
		await root.cleanup();
	}
});

it("reclaims partial descriptor merges after an injected read failure", async () => {
	const root = await spoolRoot();
	const real = controlledIo().io;
	let reads = 0;
	let failing = false;
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			...real,
			readFile(path) {
				if (failing && /[/\\]value-/.test(path) && ++reads === 2)
					return Promise.reject(new Error("EIO: descriptor merge"));
				return real.readFile(path);
			},
		},
	});
	const index = new CompactContentIndex<Record<string, number>>(store, () => [], 1);
	try {
		const original = Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`field${n}`, n]));
		index.set("row", original);
		await store.idle();
		const cut = index.freeze();
		const row = (await index.page(cut)).rows[0].row;
		const replacement = index.values.own(999);
		await store.idle();
		const before = store.status().structuredBytes;
		failing = true;
		await expect(index.values.merge(row.value, new Map([["field0", replacement]]))).rejects.toMatchObject({
			name: "CompactStorageReadError",
		});
		failing = false;
		await store.idle();
		expect(store.status().structuredBytes).toEqual(before);
		expect(store.status().reclaimDebtBytes).toBe(0);
		expect((await index.entries(cut)).get("row")).toEqual(original);
		store.adjust(replacement.owner, -1, 0);
		index.release(cut);
	} finally {
		await store.retire();
		await root.cleanup();
	}
});
