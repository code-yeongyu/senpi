import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { ROUND_CACHE_BYTES } from "../../../src/modes/rpc/compact-paged-tree.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4559: the round cache is bounded while a round runs and holds nothing once the round ends.
it("keeps each round's decoded-node cache within its budget and releases it after the round", async () => {
	const count = 8000;
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
	const tree = index.bases as unknown as {
		cache: Map<number, unknown> | undefined;
		cacheBytes: number;
		remember(...args: unknown[]): unknown;
	};
	let peak = 0;
	const remember = tree.remember.bind(tree);
	vi.spyOn(tree, "remember").mockImplementation((...args) => {
		const result = remember(...args);
		peak = Math.max(peak, tree.cacheBytes);
		return result;
	});
	const retained: { entries: number; bytes: number }[] = [];
	const cached = index.bases.cached.bind(index.bases);
	vi.spyOn(index.bases, "cached").mockImplementation(async (operation) => {
		try {
			return await cached(operation);
		} finally {
			retained.push({ entries: tree.cache?.size ?? 0, bytes: tree.cacheBytes });
		}
	});
	try {
		for (let n = 0; n < count; n++) index.set(`k${String((n * 1031) % count).padStart(5, "0")}`, { n });
		await store.idle();
		expect(retained.length).toBeGreaterThanOrEqual(Math.floor(count / 128) - 1);
		expect(peak).toBeLessThanOrEqual(ROUND_CACHE_BYTES);
		// A round at this size outgrows the former 32 KiB budget; the larger budget is actually used.
		expect(peak).toBeGreaterThan(32 * 1024);
		expect(retained.every(({ entries, bytes }) => entries === 0 && bytes === 0)).toBe(true);
		expect(tree.cache).toBeUndefined();
	} finally {
		vi.restoreAllMocks();
		await store.retire();
		await root.cleanup();
	}
}, 120_000);
