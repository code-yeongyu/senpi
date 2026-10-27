import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
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
