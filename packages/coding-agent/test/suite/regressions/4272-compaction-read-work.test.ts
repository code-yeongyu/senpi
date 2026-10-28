import { expect, it, vi } from "vitest";
import { type BaseRow, CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: count real leaf hydration, not elapsed time or mocked navigation.
it.each(
	[256, 1024].flatMap((count) =>
		(["bounded", "cache-disabled", "per-row-get"] as const).map((mode) => ({ count, mode })),
	),
)("bounds hydration while compacting $count rows ($mode)", async ({ count, mode }) => {
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
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	const pause = vi.spyOn(index["compactor"], "schedule").mockImplementation(() => undefined);
	const cached = vi.spyOn(index.bases, "cached");
	const batched = vi.spyOn(index.bases, "getMany");
	const points = vi.spyOn(index.bases, "get");
	// Mutation seams call the real operations: only the optimizations are removed.
	if (mode === "cache-disabled") cached.mockImplementation((operation) => operation());
	if (mode === "per-row-get")
		batched.mockImplementation(async (base, keys) => {
			const found = new Map<string, BaseRow>();
			for (const key of keys) {
				const row = await index.bases.get(base, key);
				if (row) found.set(key, row);
			}
			return found;
		});
	try {
		for (let n = 0; n < count; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		pause.mockRestore();
		const reads = vi.spyOn(store, "readLeaf");
		index.maybeCompact();
		await store.idle();
		const hydrations = reads.mock.calls.length;
		reads.mockRestore();
		// The first round folds into an empty base; each later 128-row append round rehydrates its upper path
		// once, shared by the selection lookup and the batched apply (without the round cache, it is read twice).
		const bound = (Math.ceil(count / 128) - 1) * Math.ceil(Math.log2(count));
		if (mode === "cache-disabled") expect(hydrations).toBeGreaterThan(bound);
		else expect(hydrations).toBeLessThanOrEqual(bound);
		// A warm path can hide disk reads, but must not hide one root descent per overlay key.
		if (mode === "per-row-get") expect(points.mock.calls.length).toBeGreaterThanOrEqual(count);
		else expect(points.mock.calls.length).toBe(0);
		expect(index.status()).toMatchObject({ baseRows: count, overrideSlots: 0 });
		expect(store.status()).toMatchObject({ structuredBytes: { resident: 0 }, failures: [] });
		expect(index.bases["cache"]).toBeUndefined();
		const cut = index.freeze();
		try {
			expect((await index.entries(cut)).size).toBe(count);
		} finally {
			index.release(cut);
		}
	} finally {
		pause.mockRestore();
		cached.mockRestore();
		batched.mockRestore();
		points.mockRestore();
		await store.retire();
		await root.cleanup();
	}
});
