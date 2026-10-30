import { expect, it } from "vitest";
import { CompactContentIndex, type IndexCursor } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272 / RULING-26a condition 4: structural payloads spill; membership is explicitly resident in 1b-I.
it("bounds page buffers over 1,024 rows and releases every allocation after the last cut", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, spillAboveBytes: 0, spillTargetBytes: 0 });
	const index = new CompactContentIndex<{ body: string }>(store, () => [], 128);
	try {
		for (let batch = 0; batch < 8; batch++) {
			for (let n = batch * 128; n < (batch + 1) * 128; n++)
				index.set(String(n).padStart(5, "0"), { body: "x".repeat(8192) });
			await store.idle();
			expect(store.status().structuredBytes.resident).toBe(0);
		}
		const cut = index.freeze();
		let cursor: IndexCursor | undefined;
		let count = 0;
		do {
			const page = await index.page(cut, cursor);
			expect(page.rows.length).toBeLessThanOrEqual(128);
			expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThanOrEqual(65_536);
			count += page.rows.length;
			cursor = page.next;
		} while (cursor);
		expect(count).toBe(1024);
		expect(index.status()).toMatchObject({ residentPages: 0, baseRows: 1024 });
		expect(index.status().peakResidentPages).toBeLessThanOrEqual(2);
		// Header residency is not hidden inside the payload budget.
		expect(index.status().residentIndexNodes).toBeLessThanOrEqual(2 * 1024);
		index.release(cut);
		for (let n = 0; n < 1024; n++) index.delete(String(n).padStart(5, "0"));
		await store.idle();
		expect(index.status()).toMatchObject({ baseRows: 0, overrideSlots: 0, residentIndexNodes: 0 });
		expect(store.status()).toMatchObject({
			structuredBytes: { resident: 0, spilled: 0, pinned: 0 },
			reclaimDebtBytes: 0,
		});
	} finally {
		await store.retire();
		await root.cleanup();
	}
}, 120_000);
