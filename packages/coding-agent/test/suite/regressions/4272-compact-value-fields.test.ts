import { afterEach, expect, it, vi } from "vitest";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactValues, type ValueRef } from "../../../src/modes/rpc/compact-values.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// Part of #4272 (S11a, carry 45, RULING-59 B): `CompactValues.fields` pages a stored key like `rows` pages a row,
// one value page resident, and `merge` never assembles a base key longer than the patch names it compares it with.

afterEach(() => {
	vi.restoreAllMocks();
});

const KEY = "k".repeat(1024 * 1024);

async function rig() {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, io: controlledIo().io });
	const values = new CompactValues(store);
	const own = (fields: Record<string, unknown>) => {
		const refs = new Map<string, ValueRef>();
		for (const [name, value] of Object.entries(fields)) refs.set(name, values.own(value));
		const ref = values.record(refs);
		for (const value of refs.values()) store.adjust(value.owner, -1, 0);
		return ref;
	};
	const base = own({ [KEY]: 1, b: 2 });
	return {
		store,
		values,
		base,
		own,
		async close() {
			await store.retire();
			await root.cleanup();
		},
	};
}

it("carry 45 merging over a 1 MiB key reads one of its 256 pages, holds one page resident and keeps the key", async () => {
	const fixture = await rig();
	try {
		const { store, values, base } = fixture;
		const patch = new Map<string, ValueRef>([["b", values.own(3)]]);
		const reads = vi.spyOn(store, "readLeaf");
		values.peakResidentPages = 0;
		const merged = await values.merge(base, patch);
		expect(values.peakResidentPages, "one value page resident while the keys are matched").toBe(1);
		expect(reads.mock.calls.length, "the object page, the key's first page, the reversed page").toBeLessThanOrEqual(
			3,
		);
		expect(await values.read(merged)).toEqual({ [KEY]: 1, b: 3 });
		store.adjust(merged.owner, -1, 0);
		for (const value of patch.values()) store.adjust(value.owner, -1, 0);
	} finally {
		await fixture.close();
	}
});

it("carry 45 a patch name equal to the large key matches it exactly; a longer or shorter name never does", async () => {
	const fixture = await rig();
	try {
		const { store, values, base } = fixture;
		for (const [name, expected] of [
			[KEY, { [KEY]: 9, b: 2 }],
			[`${KEY}x`, { [KEY]: 1, b: 2, [`${KEY}x`]: 9 }],
			[KEY.slice(0, -1), { [KEY]: 1, b: 2, [KEY.slice(0, -1)]: 9 }],
		] as const) {
			const patch = new Map<string, ValueRef>([[name, values.own(9)]]);
			values.peakResidentPages = 0;
			const merged = await values.merge(base, patch);
			expect(values.peakResidentPages).toBe(1);
			expect(await values.read(merged)).toEqual(expected);
			store.adjust(merged.owner, -1, 0);
			for (const value of patch.values()) store.adjust(value.owner, -1, 0);
		}
	} finally {
		await fixture.close();
	}
});
