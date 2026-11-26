import { CompactCommitDependencies } from "./compact-commit-dependencies.ts";
import type { CompactContentStore, LeafId } from "./compact-content-store.ts";
import { CompactIndexTree, type IndexNode } from "./compact-index-tree.ts";
import { CompactPagedTree, type PagedRoot } from "./compact-paged-tree.ts";
import { CompactReadError, CompactReadLease } from "./compact-read-lease.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";
import { CompactIndexCompactor } from "./compact-index-compactor.ts";
import { readIndexEntries, readIndexPage } from "./compact-index-traversal.ts";

export interface IndexRow {
	readonly key: ValueRef;
	readonly value: ValueRef;
	readonly payload: LeafId;
}
export interface IndexPage {
	readonly path: string;
	readonly bytes: number;
	readonly count: number;
	readonly owner: LeafId;
}
export interface BaseRow {
	readonly page: IndexPage;
	readonly offset: number;
}
export interface IndexOverride {
	readonly row: IndexRow | undefined;
	readonly patch: ReadonlyMap<string, ValueRef>;
	readonly patchValue: ValueRef | undefined;
	readonly owner: LeafId;
	readonly deleted: boolean;
}
export interface FrozenIndex {
	readonly base: PagedRoot | undefined;
	readonly overrides: IndexNode<IndexOverride> | undefined;
}
export interface IndexCursor {
	readonly cut: FrozenIndex;
	readonly after: string;
}

/** Pending overlays stay resident; settled keys and navigation paths live in spillable nodes. */
export class CompactContentIndex<Row extends object> {
	readonly store: CompactContentStore;
	readonly values: CompactValues;
	readonly bases: CompactPagedTree<BaseRow>;
	readonly overlays: CompactIndexTree<IndexOverride>;
	base: PagedRoot | undefined;
	overrides: IndexNode<IndexOverride> | undefined;
	readonly pages = new Set<IndexPage>();
	readonly pending: CompactCommitDependencies<string>;
	/** Overlay keys with no pending reference: the compactor selects only from these, in key order. */
	readonly ready = new Set<string>();
	private readonly leavesOf: (row: Row) => readonly LeafId[];
	private readonly compactor: CompactIndexCompactor;
	private readonly cuts = new WeakMap<FrozenIndex, CompactReadLease>();
	private tombstones = 0;
	private maskUnits = 0;
	residentPages = 0;
	peakResidentPages = 0;

	constructor(store: CompactContentStore, leavesOf: (row: Row) => readonly LeafId[], threshold: number) {
		this.store = store;
		this.leavesOf = leavesOf;
		this.values = new CompactValues(store);
		this.bases = new CompactPagedTree(store, ({ page }) => [page.owner]);
		this.overlays = new CompactIndexTree((value, live, pins) => store.adjust(value.owner, live, pins));
		this.pending = new CompactCommitDependencies(store, (key) => {
			this.ready.add(key);
			this.maybeCompact();
		});
		this.compactor = new CompactIndexCompactor(this, threshold);
	}

	set(key: string, row: Row): void {
		const value = this.values.own(row);
		const refs = [value.owner];
		try {
			const keyRef = this.values.own(key);
			refs.push(keyRef.owner);
			const payload = this.store.text.own(this.leavesOf(row));
			refs.push(payload);
			this.put(key, { key: keyRef, value, payload }, new Map(), false);
		} finally {
			for (const ref of refs) this.store.adjust(ref, -1, 0);
		}
	}

	patch(key: string, fields: Partial<Row>): void {
		const current = this.overlays.get(this.overrides, key);
		const patch = new Map(current?.patch);
		const owned: ValueRef[] = [];
		try {
			for (const [name, value] of Object.entries(fields)) {
				const ref = this.values.own(value);
				owned.push(ref);
				patch.set(name, ref);
			}
			this.put(key, current?.row, patch, false);
		} finally {
			for (const ref of owned) this.store.adjust(ref.owner, -1, 0);
		}
	}

	delete(key: string): void {
		this.put(key, undefined, new Map(), true);
	}

	freeze(): FrozenIndex {
		this.store.assertReadable();
		const cut = { base: this.base, overrides: this.overrides };
		this.bases.adjust(cut.base, 0, 1);
		this.overlays.adjust(cut.overrides, 0, 1);
		this.cuts.set(
			cut,
			new CompactReadLease(
				() => {
					this.bases.adjust(cut.base, 0, -1);
					this.overlays.adjust(cut.overrides, 0, -1);
				},
				() => this.store.assertReadable(),
			),
		);
		return cut;
	}

	release(cut: FrozenIndex): void {
		this.lease(cut).release();
	}

	/** Point descriptor read under a cut lease; never hydrates a message or its block collection. */
	async lookup(cut: FrozenIndex, key: string): Promise<IndexRow | undefined> {
		return this.lease(cut).run(async () => {
			const change = this.overlays.get(cut.overrides, key);
			if (change?.deleted) return undefined;
			if (change?.row) return change.row;
			const old = await this.bases.get(cut.base, key);
			if (!old) return undefined;
			using held = await this.readPage(old.page);
			return held.rows[old.offset];
		});
	}

	/** Compatibility assembly only; recovery descriptors use page(), never this whole-row view. */
	async entries(cut: FrozenIndex): Promise<Map<string, Row>> {
		return this.lease(cut).run(() => readIndexEntries(this, cut));
	}

	async page(cut: FrozenIndex, cursor?: IndexCursor) {
		return this.lease(cut).run(() => readIndexPage(this, cut, cursor));
	}

	async readPage(page: IndexPage) {
		if (page.bytes > 65_536) throw new CompactReadError("size_limit");
		if (page.count > 128) throw new CompactReadError("count_limit");
		this.peakResidentPages = Math.max(this.peakResidentPages, ++this.residentPages);
		try {
			const data = await this.store.readFile(page.path, page.bytes, "page_read");
			const rows: IndexRow[] = JSON.parse(data.toString("utf8"));
			if (rows.length > 128) throw new CompactReadError("count_limit");
			if (rows.length !== page.count) throw new CompactReadError("ownership");
			return {
				rows,
				[Symbol.dispose]: () => {
					this.residentPages--;
				},
			};
		} catch (error) {
			this.residentPages--;
			throw error;
		}
	}

	status() {
		return {
			overrideSlots: this.overrides?.size ?? 0,
			deletionMasks: this.tombstones,
			deletionMaskBytes: this.maskUnits * 2,
			basePages: this.pages.size,
			baseRows: this.base?.size ?? 0,
			residentIndexNodes: this.overlays.residentNodes,
			allocatedIndexNodes: this.bases.allocatedNodes + this.overlays.allocatedNodes,
			residentPages: this.residentPages + this.values.residentPages,
			peakResidentPages: this.peakResidentPages + this.values.peakResidentPages,
		};
	}

	maybeCompact(): void {
		this.compactor.schedule();
	}

	drop(key: string): void {
		const old = this.overlays.get(this.overrides, key);
		if (!old) return;
		if (old.deleted) {
			this.tombstones--;
			this.maskUnits -= key.length;
		}
		const next = this.overlays.set(this.overrides, key, undefined);
		this.overlays.adjust(this.overrides, -1, 0);
		this.overrides = next;
		this.pending.delete(key);
		this.ready.delete(key);
	}

	private put(key: string, row: IndexRow | undefined, patch: ReadonlyMap<string, ValueRef>, deleted: boolean): void {
		const patchValue = patch.size ? this.values.record(patch) : undefined;
		const refs = patchValue ? [patchValue.owner] : [];
		if (row) refs.push(row.key.owner, row.value.owner, row.payload);
		const owner = this.store.text.own(refs);
		this.drop(key);
		const next = this.overlays.set(this.overrides, key, { row, patch, patchValue, owner, deleted });
		this.overlays.adjust(this.overrides, -1, 0);
		this.overrides = next;
		this.store.adjust(owner, -1, 0);
		if (patchValue) this.store.adjust(patchValue.owner, -1, 0);
		if (deleted) {
			this.tombstones++;
			this.maskUnits += key.length;
		}
		this.pending.set(key, refs);
		if (!this.pending.has(key)) this.ready.add(key);
		this.maybeCompact();
	}

	private lease(cut: FrozenIndex): CompactReadLease {
		const lease = this.cuts.get(cut);
		if (!lease) throw new CompactReadError("ownership");
		return lease;
	}
}
