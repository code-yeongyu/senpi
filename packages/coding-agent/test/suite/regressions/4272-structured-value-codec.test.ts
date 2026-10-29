import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { COMPACT_SEGMENT_BYTES } from "../../../src/modes/rpc/compact-segment-storage.ts";
import { CompactValues } from "../../../src/modes/rpc/compact-values.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: the first staged commit has no production caller; the index commit wires this codec.
it("owns nested input and oversized keys while every stored field or string page stays bounded", async () => {
	const root = await spoolRoot();
	const control = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: control.io });
	const codec = new CompactValues(store);
	const key = "가".repeat(40_000);
	const body = "\uD800" + "x".repeat(100_000);
	const input = { [key]: body, nested: { n: 1 } };
	const write = control.hold("write");
	const ref = codec.own(input);
	try {
		await write.entered;
		input[key] = "changed";
		input.nested.n = 99;
		write.release();
		await store.idle();
		for (const file of await readdir(root.dir)) {
			if (file.startsWith("value-")) expect((await stat(join(root.dir, file))).size).toBeLessThanOrEqual(65_536);
		}
		expect(await codec.read(ref)).toEqual({ [key]: body, nested: { n: 1 } });
		expect(store.status().structuredBytes.resident).toBe(0);
		store.adjust(ref.owner, -1, 0);
		await store.idle();
		expect(store.status().structuredBytes).toEqual({ resident: 0, spilled: 0, pinned: 0 });
		expect(store.text.residentNodes).toBe(0);
	} finally {
		write.release();
		await store.retire();
		await root.cleanup();
	}
});

// senpi#4272 (SP3): one structural value batch is split into files within the page bound, never one oversized file.
it("splits a value batch over three page bounds into bounded segment files that read back exactly", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const units = [32_768, 1, 20_000, 20_000, 20_000, 32_768, 5_000, 30_000, 2_000, 12_000, 32_767, 9];
	const total = units.reduce((sum, count) => sum + count * 2, 0);
	expect(total).toBeGreaterThan(3 * COMPACT_SEGMENT_BYTES);
	const texts = units.map((count, n) => String.fromCharCode(0x41 + n).repeat(count - 1) + "\uD800");
	try {
		const ids = texts.map((text) => store.createLeaf(text, true));
		await store.flushValues();
		await store.idle();
		const files = (await readdir(root.dir)).filter((file) => file.startsWith("value-"));
		expect(files.length).toBeGreaterThanOrEqual(Math.ceil(total / COMPACT_SEGMENT_BYTES));
		expect(files.length).toBeLessThan(units.length);
		for (const file of files)
			expect((await stat(join(root.dir, file))).size).toBeLessThanOrEqual(COMPACT_SEGMENT_BYTES);
		for (const [n, id] of ids.entries()) {
			expect(store.isCommitted(id)).toBe(true);
			expect(await store.readLeaf(id)).toBe(texts[n]);
		}
		for (const id of ids) store.adjust(id, -1, 0);
		await store.idle();
		expect((await readdir(root.dir)).filter((file) => file.startsWith("value-"))).toEqual([]);
	} finally {
		await store.retire();
		await root.cleanup();
	}
});

it.each([128, 129])("traverses %i array entries through count-bounded pages without truncating", async (count) => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const codec = new CompactValues(store);
	const input = Array.from({ length: count }, (_, n) => n);
	const ref = codec.own(input);
	try {
		await store.idle();
		let cursor: typeof ref | undefined = ref;
		let seen = 0;
		while (cursor) {
			using page = await codec.page(cursor);
			if (page.value.kind !== "array") throw new Error("expected array descriptors");
			expect(page.value.items.length).toBeLessThanOrEqual(128);
			expect(Buffer.byteLength(JSON.stringify(page.value))).toBeLessThanOrEqual(65_536);
			seen += page.value.items.length;
			cursor = page.value.next;
		}
		expect(seen).toBe(count);
		expect(await codec.read(ref)).toEqual(input);
		store.adjust(ref.owner, -1, 0);
		await store.idle();
		expect(codec.residentPages).toBe(0);
	} finally {
		await store.retire();
		await root.cleanup();
	}
});
