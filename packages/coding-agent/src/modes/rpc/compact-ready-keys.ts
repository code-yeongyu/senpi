import { CompactIndexTree, type IndexNode } from "./compact-index-tree.ts";

/** Immutable AVL roots keep a round's iteration stable across page-read awaits. */
export class CompactReadyKeys {
	private readonly tree = new CompactIndexTree<true>(() => {});
	private root: IndexNode<true> | undefined;

	has(key: string): boolean {
		return this.tree.get(this.root, key) === true;
	}

	add(key: string): void {
		if (!this.has(key)) this.replace(key, true);
	}

	delete(key: string): void {
		if (this.has(key)) this.replace(key, undefined);
	}

	*[Symbol.iterator](): IterableIterator<string> {
		for (const [key] of this.tree.entries(this.root)) yield key;
	}

	private replace(key: string, value: true | undefined): void {
		const previous = this.root;
		this.root = this.tree.set(previous, key, value);
		this.tree.adjust(previous, -1, 0);
	}
}
