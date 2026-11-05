import type { CompactContentStore, LeafId } from "./compact-content-store.ts";

/** Per-owner readiness, independent of counted references: one leaf can unblock many rows/trees. */
export class CompactCommitDependencies<Key> {
	private readonly pending = new Map<Key, Set<LeafId>>();
	private readonly dependants = new Map<LeafId, Set<Key>>();
	private readonly store: CompactContentStore;

	constructor(store: CompactContentStore, ready: (key: Key) => void) {
		this.store = store;
		store.subscribeCommitted((id) => {
			const keys = this.dependants.get(id);
			this.dependants.delete(id);
			for (const key of keys ?? []) {
				const pending = this.pending.get(key);
				pending?.delete(id);
				if (pending?.size === 0) {
					this.pending.delete(key);
					ready(key);
				}
			}
		});
	}

	get size(): number {
		return this.pending.size;
	}

	has(key: Key): boolean {
		return this.pending.has(key);
	}

	set(key: Key, refs: readonly LeafId[]): void {
		this.delete(key);
		const pending = new Set(refs.filter((id) => !this.store.isCommitted(id)));
		if (pending.size === 0) return;
		this.pending.set(key, pending);
		for (const id of pending) {
			const keys = this.dependants.get(id) ?? new Set<Key>();
			keys.add(key);
			this.dependants.set(id, keys);
		}
	}

	delete(key: Key): void {
		for (const id of this.pending.get(key) ?? []) {
			const keys = this.dependants.get(id);
			keys?.delete(key);
			if (keys?.size === 0) this.dependants.delete(id);
		}
		this.pending.delete(key);
	}
}
