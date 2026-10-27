import { readdir } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactValues } from "../../../src/modes/rpc/compact-values.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: one array descriptor per 128 scalars, plus the spool ownership marker.
it("spools 2,000 numbers in at most ceil(2000/128) + 1 files", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const codec = new CompactValues(store);
	const input = Array.from({ length: 2_000 }, (_, n) => n);
	const ref = codec.own(input);
	try {
		await store.idle();
		expect((await readdir(root.dir)).length).toBeLessThanOrEqual(Math.ceil(input.length / 128) + 1);
		expect(await codec.read(ref)).toEqual(input);
	} finally {
		store.adjust(ref.owner, -1, 0);
		await store.retire();
		await root.cleanup();
	}
}, 60_000);

it.each(["array", "object"])("reads every %s page exactly once", async (kind) => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const codec = new CompactValues(store);
	const entries = Array.from({ length: 129 }, (_, n) => [`key${n}`, "x".repeat(100)] as const);
	const input = kind === "array" ? entries.map(([, value]) => value) : Object.fromEntries(entries);
	const ref = codec.own(input);
	const reads = vi.spyOn(store, "readLeaf");
	try {
		expect(await codec.read(ref)).toEqual(input);
		const ids = reads.mock.calls.map(([id]) => id);
		expect(ids.length).toBe(new Set(ids).size);
		expect(codec.residentPages).toBe(0);
	} finally {
		store.adjust(ref.owner, -1, 0);
		await store.retire();
		await root.cleanup();
	}
});
