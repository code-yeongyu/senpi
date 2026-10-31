import { expect, it } from "vitest";
import { CompactIndexTree, type IndexNode } from "../../../src/modes/rpc/compact-index-tree.ts";

// senpi#4272 / RULING-35: deterministic state-machine testing across sharing and refcount-to-zero.
it.each([1, 0x12345678, 0xdeadbeef])("preserves AVL and map invariants through 2,048 operations, seed %i", (seed) => {
	type Value = { n: number; tag: number };
	type Root = IndexNode<Value> | undefined;
	const retained = new Map<Value, { live: number; pins: number }>();
	const tree = new CompactIndexTree<Value>((value, live, pins) => {
		const counts = retained.get(value) ?? { live: 0, pins: 0 };
		counts.live += live;
		counts.pins += pins;
		expect(counts.live).toBeGreaterThanOrEqual(0);
		expect(counts.pins).toBeGreaterThanOrEqual(0);
		if (counts.live || counts.pins) retained.set(value, counts);
		else retained.delete(value);
	});
	let root: Root;
	const reference = new Map<string, Value>();
	const cuts: { root: Root; reference: Map<string, Value> }[] = [];
	const random = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return seed >>> 0;
	};
	const inspect = (node: Root, seen: Set<IndexNode<Value>>, keys: string[]): number => {
		if (!node) return 0;
		seen.add(node);
		const left = inspect(node.left, seen, keys);
		keys.push(node.key);
		const right = inspect(node.right, seen, keys);
		expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
		expect(node.height).toBe(1 + Math.max(left, right));
		expect(node.size).toBe(1 + (node.left?.size ?? 0) + (node.right?.size ?? 0));
		expect(node.live + node.pins).toBeGreaterThan(0);
		return node.height;
	};
	const verify = () => {
		const seen = new Set<IndexNode<Value>>();
		for (const cut of [{ root, reference }, ...cuts]) {
			const keys: string[] = [];
			inspect(cut.root, seen, keys);
			const expected = [...cut.reference].sort(([a], [b]) => a.localeCompare(b));
			expect(keys).toEqual(expected.map(([key]) => key));
			expect([...tree.entries(cut.root)]).toEqual(expected);
		}
		expect(tree.residentNodes).toBe(seen.size);
		expect(new Set(retained.keys())).toEqual(new Set([...seen].map((node) => node.value)));
	};
	for (let step = 0; step < 2048; step++) {
		const op = random() % 6;
		const key = String(random() % 64).padStart(2, "0");
		if (op < 3 || op === 5) {
			const old = reference.get(key);
			const value = op === 0 ? undefined : op === 1 ? { n: step, tag: random() } : { n: step, tag: old?.tag ?? 0 };
			const next = tree.set(root, key, value);
			tree.adjust(root, -1, 0);
			root = next;
			if (value) reference.set(key, value);
			else reference.delete(key);
		} else if (op === 3 && cuts.length < 4) {
			tree.adjust(root, 0, 1);
			cuts.push({ root, reference: new Map(reference) });
		} else if (op === 4 && cuts.length) {
			const [cut] = cuts.splice(random() % cuts.length, 1);
			tree.adjust(cut.root, 0, -1);
		}
		if (step % 257 === 256) {
			tree.adjust(root, -1, 0);
			root = undefined;
			reference.clear();
		}
		verify();
	}
	tree.adjust(root, -1, 0);
	root = undefined;
	reference.clear();
	for (const cut of cuts.splice(0)) tree.adjust(cut.root, 0, -1);
	verify();
	expect(retained.size).toBe(0);
});
