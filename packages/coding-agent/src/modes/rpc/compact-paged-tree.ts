import { type CompactContentStore, type LeafId } from "./compact-content-store.ts";
import { CompactPagedBatch } from "./compact-paged-batch.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";

/**
 * Decoded-node budget of one compaction round's LRU (senpi#4559). A round's 128 rows land on up to 128 separate
 * tree paths, about 1,000 nodes of about 0.9 KiB each (as accounted below) at 8,000 rows. The selection lookup and the
 * batched apply walk the same paths, so the cache must hold a whole round's paths for the apply to reuse them.
 * Measured at 8,000 settled rows: 32 KiB re-read 67,509 nodes from the spool, 512 KiB 58,175, 1 MiB 31,543.
 */
export const ROUND_CACHE_BYTES = 1024 * 1024;

export interface PagedRoot {
	readonly ref: ValueRef;
	readonly height: number;
	readonly size: number;
}
export interface PagedNode<T> {
	readonly key: ValueRef;
	readonly value: T;
	readonly left?: PagedRoot;
	readonly right?: PagedRoot;
}

/** Cold AVL paths live in owned storage leaves; only an operation's path is hydrated. */
export class CompactPagedTree<T> {
	readonly store: CompactContentStore;
	private readonly values: CompactValues;
	private readonly leavesOf: (value: T) => readonly LeafId[];
	private dirty: LeafId[] = [];
	private cache: Map<LeafId, { node: PagedNode<T>; name: string; bytes: number }> | undefined;
	private cacheBytes = 0;
	allocatedNodes = 0;

	constructor(store: CompactContentStore, leavesOf: (value: T) => readonly LeafId[]) {
		this.store = store;
		this.values = new CompactValues(store);
		this.leavesOf = leavesOf;
	}

	adjust(root: PagedRoot | undefined, live: number, pins: number): void {
		if (root) this.store.adjust(root.ref.owner, live, pins);
	}

	/** A round-local `ROUND_CACHE_BYTES` LRU retains reused paths, including newly built ones; it ends with the round. */
	async cached<R>(operation: () => Promise<R>): Promise<R> {
		this.cache = new Map();
		this.cacheBytes = 0;
		try {
			return await operation();
		} finally {
			this.cache = undefined;
			this.cacheBytes = 0;
		}
	}

	private async read(root: PagedRoot) {
		const cached = this.cache?.get(root.ref.node);
		if (cached) {
			this.cache?.delete(root.ref.node);
			this.cache?.set(root.ref.node, cached);
			return cached;
		}
		const text = await this.store.readLeaf(root.ref.node);
		const node: PagedNode<T> = JSON.parse(text);
		const name = await this.values.read(node.key);
		if (typeof name !== "string") throw new CompactReadError("ownership");
		return this.remember(root.ref.node, node, name, text.length);
	}

	private remember(id: LeafId, node: PagedNode<T>, name: string, units: number) {
		const existing = this.cache?.get(id);
		if (existing) return existing;
		const bytes = (units + name.length) * 2 + 128;
		const decoded = { node, name, bytes };
		if (this.cache && bytes <= ROUND_CACHE_BYTES) {
			while (this.cacheBytes + bytes > ROUND_CACHE_BYTES) {
				const oldest = this.cache.entries().next().value;
				if (!oldest) break;
				this.cache.delete(oldest[0]);
				this.cacheBytes -= oldest[1].bytes;
			}
			this.cache.set(id, decoded);
			this.cacheBytes += bytes;
		}
		return decoded;
	}

	async get(root: PagedRoot | undefined, key: string): Promise<T | undefined> {
		let ref = root;
		while (ref) {
			const { node, name } = await this.read(ref);
			if (key === name) return node.value;
			ref = key < name ? node.left : node.right;
		}
		return undefined;
	}

	/** Sorted requests share each descent instead of performing one root lookup per row. */
	async getMany(root: PagedRoot | undefined, keys: readonly string[]): Promise<Map<string, T>> {
		const ordered = [...keys].sort();
		const found = new Map<string, T>();
		const visit = async (ref: PagedRoot | undefined, from: number, to: number): Promise<void> => {
			if (!ref || from === to) return;
			const { node, name } = await this.read(ref);
			let split = from;
			while (split < to && ordered[split] < name) split++;
			await visit(node.left, from, split);
			let right = split;
			while (right < to && ordered[right] === name) found.set(ordered[right++], node.value);
			await visit(node.right, right, to);
		};
		await visit(root, 0, ordered.length);
		return found;
	}

	async *entries(root: PagedRoot | undefined, after?: string): AsyncGenerator<readonly [string, T]> {
		if (!root) return;
		const { node, name: key } = await this.read(root);
		if (after === undefined || key > after) {
			yield* this.entries(node.left, after);
			yield [key, node.value];
		}
		yield* this.entries(node.right, after);
	}

	/** Applies one round's changes (undefined deletes) in one sorted pass; returns an owned root. */
	apply(root: PagedRoot | undefined, changes: ReadonlyMap<string, T | undefined>): Promise<PagedRoot | undefined> {
		return new CompactPagedBatch<T>({
			read: (ref) => this.read(ref),
			make: (node) => this.make(node),
			own: (name) => this.values.own(name),
			adjust: (ref, live) => this.adjust(ref, live, 0),
			release: (key) => this.store.adjust(key.owner, -1, 0),
		}).apply(root, changes);
	}

	private async make(node: PagedNode<T>): Promise<PagedRoot> {
		const text = JSON.stringify(node);
		// Decode before allocating: a failed key read must not strand a new leaf.
		const name = this.cache ? await this.values.read(node.key) : undefined;
		const leaf = this.store.createLeaf(text, true);
		const owner = this.store.text.own([
			leaf,
			node.key.owner,
			...this.leavesOf(node.value),
			node.left?.ref.owner ?? 0,
			node.right?.ref.owner ?? 0,
		]);
		this.store.adjust(leaf, -1, 0);
		this.dirty.push(leaf);
		this.allocatedNodes++;
		if (this.cache && typeof name === "string") this.remember(leaf, node, name, text.length);
		return {
			ref: { node: leaf, owner },
			height: 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0),
			size: 1 + (node.left?.size ?? 0) + (node.right?.size ?? 0),
		};
	}

	/**
	 * Commits a round as one segment file: nodes replaced within it were released and are skipped, so only
	 * survivors are written. Until then a round's built nodes stay resident, at most 384 keys x 3 nodes per
	 * level x (height + 1).
	 */
	async flush(): Promise<void> {
		const dirty = this.dirty;
		this.dirty = [];
		await this.store.flushLeaves(dirty);
	}
}
