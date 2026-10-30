import type { CompactContentStore, LeafId } from "./compact-content-store.ts";
import { CompactIndexTree, type IndexNode } from "./compact-index-tree.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";

interface Stored<T> {
	readonly value: T;
	readonly ref: ValueRef;
	readonly owner: LeafId;
}
interface Page {
	readonly key: ValueRef;
	readonly value: ValueRef;
	readonly left?: ValueRef;
	readonly right?: ValueRef;
}
export interface ComponentRoot<T> {
	readonly header: IndexNode<Stored<T>> | undefined;
	readonly ref: ValueRef | undefined;
}

/**
 * Active AVL headers project only changed paths into bounded, spillable nodes. Frozen and settled
 * owners retain the disk-addressable root, not the hot navigation tree or an array of its values.
 */
export class CompactComponentRoots<T extends object> {
	private readonly store: CompactContentStore;
	private readonly values: CompactValues;
	private readonly tree: CompactIndexTree<Stored<T>>;
	private readonly refs = new WeakMap<IndexNode<Stored<T>>, ValueRef>();
	private readonly leavesOf: (value: T) => readonly LeafId[];

	constructor(store: CompactContentStore, leavesOf: (value: T) => readonly LeafId[]) {
		this.store = store;
		this.values = new CompactValues(store);
		this.leavesOf = leavesOf;
		this.tree = new CompactIndexTree((value, live, pins) => store.adjust(value.owner, live, pins));
	}

	get residentNodes(): number {
		return this.tree.residentNodes;
	}

	set(root: ComponentRoot<T>, key: string, value: T | undefined): ComponentRoot<T> {
		const ref = value && this.values.own(value);
		const owner = ref && value ? this.store.text.own([ref.owner, ...this.leavesOf(value)]) : 0;
		const header = this.tree.set(root.header, key, value && ref ? { value, ref, owner } : undefined);
		if (ref) this.store.adjust(ref.owner, -1, 0);
		this.store.adjust(owner, -1, 0);
		const created: ValueRef[] = [];
		const next = header ? this.project(header, created) : undefined;
		if (next) this.store.adjust(next.owner, 1, 0);
		for (const ref of created) this.store.adjust(ref.owner, -1, 0);
		this.tree.adjust(root.header, -1, 0);
		if (root.ref) this.store.adjust(root.ref.owner, -1, 0);
		return { header, ref: next };
	}

	/** Header reclamation is off the acceptance path; the transferred payload root already owns every value. */
	release(root: ComponentRoot<T>): void {
		this.store.enqueue("reclaim", async () => {
			this.tree.adjust(root.header, -1, 0);
			if (root.ref) this.store.adjust(root.ref.owner, -1, 0);
		});
	}

	/**
	 * The incremental reader (S03b-4): rows in key order, each value as the ref its walk starts from, with one
	 * tree page resident per open level. Nothing here assembles a value; `entries` does, for the whole-view callers.
	 */
	async *rows(ref: ValueRef | undefined, valid: () => void): AsyncGenerator<readonly [string, ValueRef]> {
		if (!ref) return;
		valid();
		const page: Page = JSON.parse(await this.store.readLeaf(ref.node));
		valid();
		yield* this.rows(page.left, valid);
		const key = await this.values.read(page.key, valid);
		if (typeof key !== "string") throw new CompactReadError("ownership");
		yield [key, page.value];
		yield* this.rows(page.right, valid);
	}

	async *entries(ref: ValueRef | undefined, valid: () => void): AsyncGenerator<readonly [string, T]> {
		for await (const [key, value] of this.rows(ref, valid)) {
			const row = (await this.values.read(value, valid)) as T;
			valid();
			yield [key, row];
		}
	}

	private project(node: IndexNode<Stored<T>>, created: ValueRef[]): ValueRef {
		const known = this.refs.get(node);
		if (known) return known;
		const left = node.left && this.project(node.left, created);
		const right = node.right && this.project(node.right, created);
		// Component keys are fixed-width ordinals; unchanged path keys need no new value owner.
		const key: ValueRef = { node: 0, owner: 0, value: node.key };
		const page = this.store.createLeaf(JSON.stringify({ key, value: node.value.ref, left, right }), true);
		const owner = this.store.text.own([page, key.owner, node.value.owner, left?.owner ?? 0, right?.owner ?? 0]);
		this.store.adjust(page, -1, 0);
		const ref = { node: page, owner };
		this.refs.set(node, ref);
		created.push(ref);
		return ref;
	}
}
