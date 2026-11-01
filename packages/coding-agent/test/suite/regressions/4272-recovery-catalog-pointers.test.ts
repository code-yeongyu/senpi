import { expect, it } from "vitest";
import { catalogDigest, storedBytes } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { CatalogPointerWriter, catalogPointer } from "../../../src/modes/rpc/compact-catalog-pointers.ts";
import { COMPACT_LEAF_CODE_UNITS, type LeafId } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";

// Part of #4272 (S09a review fold): a node's pointer list of any length is a tree of side leaves, each within one
// store leaf, read back exactly one leaf per height at a time and refused as `integrity` when any leaf changed.

function sideStore() {
	const leaves = new Map<LeafId, string>();
	const writer = new CatalogPointerWriter((text) => {
		const id = leaves.size + 1;
		leaves.set(id, text);
		return id;
	});
	const read = async (id: LeafId): Promise<string> => {
		const text = leaves.get(id);
		if (text === undefined) throw new CompactReadError("ownership");
		return text;
	};
	return { leaves, writer, read };
}

it("170,000 children grow a second index height; every side leaf fits one store leaf and every child, a component spanning leaves included, reads back exactly", async () => {
	const { leaves, writer, read } = sideStore();
	const nodes = 170_000;
	const big = Array.from({ length: 20_000 }, (_, n) => n + 10);
	const nodeHead = { side: 7, digest: catalogDigest("leaf", Buffer.alloc(0)) };
	for (let n = 0; n < nodes; n++) writer.node(n === 0 ? 3 : n + 100_000, nodeHead);
	writer.component(big);
	writer.component([]);
	writer.component([5, 6]);
	const head = writer.finish();
	expect(head.digest).toBe(catalogDigest("pointer", storedBytes(leaves.get(head.side) ?? "")));
	const heights = [...leaves.values()].map((text) => Number(/^\{"h":(\d+)/.exec(text)?.[1]));
	expect(Math.max(...heights), "the index itself needed an index").toBe(2);
	for (const text of leaves.values()) expect(text.length).toBeLessThanOrEqual(COMPACT_LEAF_CODE_UNITS);
	expect(await catalogPointer(read, head, 0)).toEqual({ kind: "node", node: 3, head: nodeHead });
	expect(await catalogPointer(read, head, nodes - 1)).toEqual({
		kind: "node",
		node: nodes - 1 + 100_000,
		head: nodeHead,
	});
	expect(await catalogPointer(read, head, nodes)).toEqual({ kind: "component", leaves: big });
	expect(await catalogPointer(read, head, nodes + 1)).toEqual({ kind: "component", leaves: [] });
	expect(await catalogPointer(read, head, nodes + 2)).toEqual({ kind: "component", leaves: [5, 6] });
	expect(await catalogPointer(read, head, nodes + 3)).toBeUndefined();
	const middle = Math.floor(leaves.size / 2);
	const original = leaves.get(middle) ?? "";
	leaves.set(
		middle,
		original.replace(/\d(?=[,\]])/, (digit) => String((Number(digit) + 1) % 10)),
	);
	await expect(catalogPointer(read, head, nodes + 2)).rejects.toMatchObject({ reason: "integrity" });
	leaves.delete(middle);
	await expect(catalogPointer(read, head, nodes + 2)).rejects.toMatchObject({ reason: "ownership" });
});

it("RULING-58 (2) a side leaf that verifies but breaks the token grammar is integrity: a stray leaf id, a truncated component", async () => {
	for (const v of ["[5]", '[{"c":2},5]']) {
		const text = `{"h":0,"v":${v}}`;
		const head = { side: 1, digest: catalogDigest("pointer", storedBytes(text)) };
		await expect(
			catalogPointer(async () => text, head, 0),
			v,
		).rejects.toMatchObject({ reason: "integrity" });
	}
});
