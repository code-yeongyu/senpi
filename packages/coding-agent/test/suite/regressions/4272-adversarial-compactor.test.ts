import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { packPages } from "../../../src/modes/rpc/compact-index-pages.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272 / RULING-35: bound working buffers, excluding intentionally resident membership headers.
it("bounds compaction of mixed ceiling-sized rows and overrides spread over many pages", async () => {
	const root = await spoolRoot();
	const real = controlledIo().io;
	let measuring = false;
	let peakBytes = 0,
		peakPages = 0,
		pageWrites = 0;
	const sample = () => {
		if (!measuring) return;
		const status = store.status();
		const pages = index.residentPages + index.values.residentPages;
		peakPages = Math.max(peakPages, pages + Number(status.pendingIoCopyBytes > 0));
		peakBytes = Math.max(peakBytes, pages * 65_536 + status.structuredBytes.resident + status.pendingIoCopyBytes);
	};
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			async readFile(path) {
				sample();
				return real.readFile(path);
			},
			async writeFile(path, data) {
				sample();
				if (measuring && /[/\\]page-/.test(path)) {
					pageWrites++;
					expect(data.byteLength).toBeLessThanOrEqual(65_536);
					expect(JSON.parse(data.toString()).length).toBeLessThanOrEqual(128);
				}
				return real.writeFile(path, data);
			},
			unlink: real.unlink,
		},
	});
	const index = new CompactContentIndex<{ body: string; n: number }>(store, () => [], 1);
	const reference = new Map<string, { body: string; n: number }>();
	try {
		const pause = vi.spyOn(index["compactor"], "schedule").mockImplementation(() => undefined);
		for (let n = 0; n < 384; n++) {
			const row = { body: "", n };
			if (n % 3 !== 0) row.body = "x".repeat(65_536 - Buffer.byteLength(JSON.stringify(row)) - Number(n % 3 === 2));
			expect(Buffer.byteLength(JSON.stringify(row))).toBe(
				n % 3 === 0 ? Buffer.byteLength(JSON.stringify({ body: "", n })) : 65_536 - Number(n % 3 === 2),
			);
			const key = String(n).padStart(5, "0");
			index.set(key, row);
			reference.set(key, row);
		}
		await store.idle();
		pause.mockRestore();
		measuring = true;
		index.maybeCompact();
		await store.idle();
		expect(index.pages.size).toBe(3);
		expect([...index.pages].every((page) => page.count === 128)).toBe(true);
		measuring = false;
		const pauseAgain = vi.spyOn(index["compactor"], "schedule").mockImplementation(() => undefined);
		for (let n = 0; n < 384; n += 3) {
			const key = String(n).padStart(5, "0");
			index.patch(key, { n: -n - 1 });
			const old = reference.get(key);
			if (!old) throw new Error("missing reference row");
			reference.set(key, { ...old, n: -n - 1 });
		}
		await store.idle();
		pauseAgain.mockRestore();
		measuring = true;
		index.maybeCompact();
		await store.idle();
		measuring = false;
		expect(pageWrites).toBeGreaterThanOrEqual(6);
		// Two input pages, one output page, and at most two value-merge page buffers.
		expect(peakPages).toBeLessThanOrEqual(5);
		expect(peakBytes).toBeLessThanOrEqual(5 * 65_536);
		expect(store.status().structuredBytes.resident).toBe(0);
		expect(index.status()).toMatchObject({ overrideSlots: 0, baseRows: 384, residentPages: 0 });
		const cut = index.freeze();
		try {
			expect(await index.entries(cut)).toEqual(reference);
		} finally {
			index.release(cut);
		}
		// Exact byte and count thresholds use the same packer as the compactor.
		for (const size of [65_535, 65_536]) {
			const pages = [...packPages(["x".repeat(size - 4), 0])];
			expect(Buffer.byteLength(JSON.stringify(pages[0]))).toBe(size);
			expect(pages).toHaveLength(2);
		}
	} finally {
		vi.restoreAllMocks();
		await store.retire();
		await root.cleanup();
	}
}, 120_000);
