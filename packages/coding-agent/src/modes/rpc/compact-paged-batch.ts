import type { PagedNode, PagedRoot } from "./compact-paged-tree.ts";
import type { ValueRef } from "./compact-values.ts";

/** A changed node of the round being built: plain RAM, mutated in place until it is made once. */
interface Draft<T> {
	/** Undefined for a key new to the tree; its reference is owned only while the node is made. */
	readonly key: ValueRef | undefined;
	readonly name: string;
	value: T;
	left: Sub<T>;
	right: Sub<T>;
	height: number;
	size: number;
}
type Sub<T> = Draft<T> | PagedRoot | undefined;

export interface PagedBatchTree<T> {
	read(root: PagedRoot): Promise<{ readonly node: PagedNode<T>; readonly name: string }>;
	make(node: PagedNode<T>): Promise<PagedRoot>;
	own(name: string): ValueRef;
	adjust(root: PagedRoot | undefined, live: number): void;
	release(key: ValueRef): void;
}

/**
 * One compaction round's sorted changes (undefined deletes) merged into the AVL in one descent, with
 * join-based rebalancing (senpi#4272, RULING-47). Changed nodes stay drafts until the final tree is
 * made bottom-up, so each node of the result is built, owned and registered for commit exactly once;
 * a node replaced inside the round is never built at all.
 */
export class CompactPagedBatch<T> {
	private readonly tree: PagedBatchTree<T>;
	private changes: readonly (readonly [string, T | undefined])[] = [];

	constructor(tree: PagedBatchTree<T>) {
		this.tree = tree;
	}

	/** Returns an owned root; the caller keeps `root` live until this settles. */
	async apply(root: PagedRoot | undefined, changes: ReadonlyMap<string, T | undefined>) {
		this.changes = [...changes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return this.build(await this.merge(root, 0, this.changes.length));
	}

	private async merge(sub: Sub<T>, from: number, to: number): Promise<Sub<T>> {
		if (from === to) return sub;
		if (!sub) return this.fresh(from, to);
		const node = await this.open(sub);
		let split = from;
		while (split < to && this.changes[split][0] < node.name) split++;
		const hit = split < to && this.changes[split][0] === node.name;
		const left = await this.merge(node.left, from, split);
		const right = await this.merge(node.right, hit ? split + 1 : split, to);
		if (!hit && left === node.left && right === node.right) return sub;
		const value = hit ? this.changes[split][1] : node.value;
		if (value === undefined) return this.concat(left, right);
		node.value = value;
		return this.join(left, node, right);
	}

	/** A perfectly balanced subtree of the inserts in an empty position; deletes of absent keys are no-ops. */
	private fresh(from: number, to: number): Sub<T> {
		const rows: (readonly [string, T])[] = [];
		for (const [name, value] of this.changes.slice(from, to)) if (value !== undefined) rows.push([name, value]);
		const grow = (lo: number, hi: number): Sub<T> => {
			if (lo === hi) return undefined;
			const mid = (lo + hi) >>> 1;
			const [name, value] = rows[mid];
			const left = grow(lo, mid);
			return this.fix({ key: undefined, name, value, left, right: grow(mid + 1, hi), height: 0, size: 0 });
		};
		return grow(0, rows.length);
	}

	/** AVL join: descends the taller side's spine to a height match, rebalancing once per level. */
	private async join(left: Sub<T>, node: Draft<T>, right: Sub<T>): Promise<Draft<T>> {
		const lh = left?.height ?? 0;
		const rh = right?.height ?? 0;
		if (left && lh > rh + 1) {
			const top = await this.open(left);
			top.right = await this.join(top.right, node, right);
			return this.balance(top);
		}
		if (right && rh > lh + 1) {
			const top = await this.open(right);
			top.left = await this.join(left, node, top.left);
			return this.balance(top);
		}
		node.left = left;
		node.right = right;
		return this.fix(node);
	}

	private async concat(left: Sub<T>, right: Sub<T>): Promise<Sub<T>> {
		if (!left) return right;
		if (!right) return left;
		const [min, rest] = await this.takeMin(right);
		return this.join(left, min, rest);
	}

	private async takeMin(sub: Draft<T> | PagedRoot): Promise<[Draft<T>, Sub<T>]> {
		const node = await this.open(sub);
		if (!node.left) return [node, node.right];
		const [min, rest] = await this.takeMin(node.left);
		node.left = rest;
		return [min, await this.balance(node)];
	}

	/** One single or double rotation restores a node whose children differ in height by two. */
	private async balance(node: Draft<T>): Promise<Draft<T>> {
		const leftHeavy = (node.left?.height ?? 0) > (node.right?.height ?? 0);
		const side = leftHeavy ? "left" : "right";
		const other = leftHeavy ? "right" : "left";
		const heavy = node[side];
		if (!heavy || heavy.height - (node[other]?.height ?? 0) < 2) return this.fix(node);
		const child = await this.open(heavy);
		const inner = child[other];
		if (inner && inner.height > (child[side]?.height ?? 0)) {
			const pivot = await this.open(inner);
			child[other] = pivot[side];
			node[side] = pivot[other];
			pivot[side] = this.fix(child);
			pivot[other] = this.fix(node);
			return this.fix(pivot);
		}
		node[side] = inner;
		child[other] = this.fix(node);
		return this.fix(child);
	}

	private fix(node: Draft<T>): Draft<T> {
		node.height = 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0);
		node.size = 1 + (node.left?.size ?? 0) + (node.right?.size ?? 0);
		return node;
	}

	private async open(sub: Draft<T> | PagedRoot): Promise<Draft<T>> {
		if (!("ref" in sub)) return sub;
		const { node, name } = await this.tree.read(sub);
		const { key, value, left, right } = node;
		return { key, name, value, left, right, height: sub.height, size: sub.size };
	}

	/** Makes each draft once, children first; every result and intermediate is owned exactly once. */
	private async build(sub: Sub<T>): Promise<PagedRoot | undefined> {
		if (!sub || "ref" in sub) {
			this.tree.adjust(sub, 1);
			return sub;
		}
		const left = await this.build(sub.left);
		try {
			const right = await this.build(sub.right);
			try {
				const key = sub.key ?? this.tree.own(sub.name);
				try {
					return await this.tree.make({ key, value: sub.value, left, right });
				} finally {
					if (!sub.key) this.tree.release(key);
				}
			} finally {
				this.tree.adjust(right, -1);
			}
		} finally {
			this.tree.adjust(left, -1);
		}
	}
}
