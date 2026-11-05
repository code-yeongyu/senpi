import { expect, it, vi } from "vitest";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactValues } from "../../../src/modes/rpc/compact-values.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272: write failures are typed and cannot strand partially constructed owners. Size, depth and node count
// are not refused since S03b-4 (4272-compact-legal-large-values); a cycle is not a JSON value and still is.
it("refuses a cycle without leaking", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const codec = new CompactValues(store);
	const cycle: unknown[] = [];
	cycle.push({ inner: cycle });
	try {
		expect(() => codec.own(cycle)).toThrowError(
			expect.objectContaining({ name: "CompactWriteError", reason: "cycle" }),
		);
		await store.idle();
		expect(store.status().structuredBytes).toEqual({ resident: 0, spilled: 0, pinned: 0 });
		expect(store.text.residentNodes).toBe(0);
	} finally {
		await store.retire();
		await root.cleanup();
	}
});

it.each([6, 132])("releases completed siblings and prior pages after write %i throws", async (failAt) => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir });
	const codec = new CompactValues(store);
	const keep = codec.own({ stable: "keep".repeat(100) });
	await store.idle();
	const baseline = store.status().structuredBytes;
	const nodes = store.text.residentNodes;
	const create = store.createLeaf.bind(store);
	let writes = 0;
	const spy = vi.spyOn(store, "createLeaf").mockImplementation((text, value) => {
		if (++writes === failAt) throw new Error("injected write");
		return create(text, value);
	});
	try {
		expect(() =>
			codec.own(Object.fromEntries(Array.from({ length: 140 }, (_, n) => [`key${n}`, "x".repeat(500)]))),
		).toThrow("injected write");
		spy.mockRestore();
		await store.idle();
		expect(store.status().structuredBytes).toEqual(baseline);
		expect(store.text.residentNodes).toBe(nodes);
		store.adjust(keep.owner, -1, 0);
		await store.idle();
		expect(store.status().structuredBytes).toEqual({ resident: 0, spilled: 0, pinned: 0 });
		expect(store.text.residentNodes).toBe(0);
	} finally {
		spy.mockRestore();
		await store.retire();
		await root.cleanup();
	}
});

it.each([new Date(0), new Map(), new Set(), undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol("x")])(
	"rejects unsupported JSON input %s with a typed error",
	async (input) => {
		const root = await spoolRoot();
		const store = new CompactContentStore({ dir: root.dir });
		try {
			expect(() => new CompactValues(store).own({ nested: input })).toThrowError(
				expect.objectContaining({ name: "CompactWriteError", reason: "unsupported_value" }),
			);
		} finally {
			await store.retire();
			await root.cleanup();
		}
	},
);
