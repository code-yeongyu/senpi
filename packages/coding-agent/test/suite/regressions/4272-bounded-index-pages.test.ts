import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { packPages } from "../../../src/modes/rpc/compact-index-pages.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272, RULING-26a condition 4: neither a row nor its key may escape the page ceiling.
it("spills an oversized structured row and key without an oversized page or truncation", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, spillAboveBytes: 0, spillTargetBytes: 0 });
	const index = new CompactContentIndex<{ body: string; nested: number[] }>(store, () => [], 1);
	const key = "가".repeat(40_000);
	const row = { body: "\uD800" + "x".repeat(100_000), nested: Array.from({ length: 1024 }, (_, i) => i) };
	try {
		index.set(key, row);
		await store.idle();
		for (const name of await readdir(root.dir)) {
			if (name.endsWith(".bin")) expect((await stat(join(root.dir, name))).size).toBeLessThanOrEqual(65_536);
		}
		const cut = index.freeze();
		try {
			expect((await index.entries(cut)).get(key)).toEqual(row);
		} finally {
			index.release(cut);
		}
	} finally {
		await store.retire();
		await root.cleanup();
	}
});

it("packs the exact byte and count ceilings and rejects a raw oversized row before yielding", () => {
	expect([...packPages(["x".repeat(65_532)])][0]).toHaveLength(1);
	expect(() => [...packPages(["x".repeat(65_533)])]).toThrow(
		expect.objectContaining({ name: "CompactWriteError", reason: "size_limit" }),
	);
	const pages = [...packPages(Array.from({ length: 129 }, (_, n) => n))];
	expect(pages.map((page) => page.length)).toEqual([128, 1]);
	expect(pages.flat()).toEqual(Array.from({ length: 129 }, (_, n) => n));
});
