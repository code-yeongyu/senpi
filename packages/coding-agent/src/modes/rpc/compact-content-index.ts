import type { CompactContentStore, LeafId } from "./compact-content-store.ts";
import { CompactCommitDependencies } from "./compact-commit-dependencies.ts";
import { isSmallPage, packPages } from "./compact-index-pages.ts";
import { CompactReadError } from "./compact-read-lease.ts";

/**
 * A spillable keyed collection: an immutable paged disk base plus one resident override slot per key
 * (senpi#4272). Updates coalesce into that slot, so N updates to one key hold one slot, and a cold row
 * changes without reading its page. Background compaction folds eligible overrides into new pages and
 * publishes them in one synchronous swap that never removes an override newer than the one it read.
 * A failed compaction leaves the previous base in place and the next one free to run.
 * Pages are internal storage only; nothing here is a wire record.
 */

type Override<Row> =
	| { readonly kind: "row"; readonly row: Row }
	| { readonly kind: "patch"; readonly patch: Partial<Row> }
	| { readonly kind: "tombstone" };

interface Page {
	readonly path: string;
	readonly bytes: number;
	/** Published keys; a row skipped at publication stays in the file but is never read back. */
	readonly keys: readonly string[];
	readonly leaves: readonly LeafId[];
	inBase: boolean;
	pins: number;
}

interface WrittenPage<Row> {
	readonly path: string;
	readonly bytes: number;
	readonly rows: readonly [string, Row][];
}

interface IndexBase {
	readonly pages: readonly Page[];
	readonly pageOf: ReadonlyMap<string, Page>;
}

export interface FrozenIndex<Row> {
	readonly base: IndexBase;
	readonly overrides: ReadonlyMap<string, Override<Row>>;
}

export class CompactContentIndex<Row extends object> {
	private readonly store: CompactContentStore;
	private readonly leavesOf: (row: Row) => readonly LeafId[];
	private readonly compactAboveRows: number;
	private base: IndexBase = { pages: [], pageOf: new Map() };
	private readonly overrides = new Map<string, Override<Row>>();
	/** Uncommitted leaves per row override; only overrides absent here are eligible to fold. */
	private readonly unsettledLeaves: CompactCommitDependencies<string>;
	private compacting = false;
	private tombstones = 0;
	private tombstoneKeyUnits = 0;
	private readonly frozen = new WeakSet<FrozenIndex<Row>>();

	constructor(store: CompactContentStore, leavesOf: (row: Row) => readonly LeafId[], compactAboveRows: number) {
		this.store = store;
		this.leavesOf = leavesOf;
		this.compactAboveRows = compactAboveRows;
		this.unsettledLeaves = new CompactCommitDependencies(store, () => this.maybeCompact());
	}

	has(key: string): boolean {
		const override = this.overrides.get(key);
		return override ? override.kind !== "tombstone" : this.base.pageOf.has(key);
	}

	set(key: string, row: Row): void {
		this.put(key, { kind: "row", row });
	}

	patch(key: string, fields: Partial<Row>): void {
		const current = this.overrides.get(key);
		if (current?.kind === "row") this.put(key, { kind: "row", row: { ...current.row, ...fields } });
		else if (current?.kind === "patch") this.put(key, { kind: "patch", patch: { ...current.patch, ...fields } });
		else this.put(key, { kind: "patch", patch: fields });
	}

	/** A key only the overlay ever held leaves no tombstone; a committed one is masked until compaction. */
	delete(key: string): void {
		if (this.base.pageOf.has(key)) this.put(key, { kind: "tombstone" });
		else this.drop(key);
	}

	freeze(): FrozenIndex<Row> {
		for (const page of this.base.pages) page.pins++;
		for (const override of this.overrides.values()) this.pinRow(override, 1);
		const frozen = { base: this.base, overrides: new Map(this.overrides) };
		this.frozen.add(frozen);
		return frozen;
	}

	release(frozen: FrozenIndex<Row>): void {
		if (!this.frozen.delete(frozen)) return;
		for (const override of frozen.overrides.values()) this.pinRow(override, -1);
		for (const page of frozen.base.pages) {
			page.pins--;
			if (!page.inBase && page.pins === 0) this.reclaimPage(page, 0, -1);
		}
	}

	/** Every row visible at a frozen root, reading only that root's own pages. */
	async entries(frozen: FrozenIndex<Row>): Promise<Map<string, Row>> {
		if (!this.frozen.has(frozen)) throw new CompactReadError("released");
		const rows = new Map<string, Row>();
		for (const page of frozen.base.pages) for (const [key, row] of await this.readPage(page)) rows.set(key, row);
		applyOverrides(rows, frozen.overrides);
		return rows;
	}

	status() {
		return {
			overrideSlots: this.overrides.size,
			deletionMasks: this.tombstones,
			deletionMaskBytes: this.tombstoneKeyUnits * 2,
			basePages: this.base.pages.length,
			baseRows: this.base.pageOf.size,
		};
	}

	/** The acceptance path checks counts only: an override is eligible once none of its leaves is uncommitted. */
	maybeCompact(): void {
		if (this.compacting || !this.store.spillAllowed) return;
		if (this.overrides.size - this.unsettledLeaves.size < this.compactAboveRows) return;
		this.compacting = true;
		this.store.enqueue("page_write", async () => {
			let progressed = false;
			try {
				progressed = await this.compact();
			} finally {
				this.compacting = false;
			}
			if (progressed) this.maybeCompact();
		});
	}

	/** Folds eligible overrides and every small base page; false leaves the previous base untouched. */
	private async compact(): Promise<boolean> {
		const base = this.base;
		const selected = [...this.overrides].filter(([key]) => !this.unsettledLeaves.has(key));
		if (selected.length < this.compactAboveRows) return false;
		const touched = new Set(base.pages.filter(isSmallPage));
		for (const [key] of selected) {
			const page = base.pageOf.get(key);
			if (page) touched.add(page);
		}
		const rows = new Map<string, Row>();
		try {
			for (const page of touched) for (const [key, row] of await this.readPage(page)) rows.set(key, row);
		} catch {
			return false;
		}
		applyOverrides(rows, new Map(selected));
		const written: WrittenPage<Row>[] = [];
		for (const chunk of packPages([...rows])) {
			const data = Buffer.from(JSON.stringify(chunk));
			const path = await this.store.writeFile(data, "page_write", data.byteLength);
			if (path === undefined || !this.store.spillAllowed) {
				for (const page of written) this.store.discard(page.path, page.bytes);
				if (path !== undefined) this.store.discard(path, data.byteLength);
				return false;
			}
			written.push({ path, bytes: data.byteLength, rows: chunk });
		}
		this.swap(base, touched, written, new Map(selected));
		return true;
	}

	/**
	 * The publication point: one synchronous step, so no acceptance observes a half-swapped index. A folded
	 * row is published only while its value is still observable (its override is the folded one, or a newer
	 * patch over it); a row removed or wholly replaced meanwhile is skipped, so every published leaf is still
	 * owned by the folded override or a touched page when its reference is added.
	 */
	private swap(
		base: IndexBase,
		touched: Set<Page>,
		written: WrittenPage<Row>[],
		selected: Map<string, Override<Row>>,
	): void {
		const pageOf = new Map(base.pageOf);
		for (const page of touched) for (const key of page.keys) pageOf.delete(key);
		const published: Page[] = [];
		for (const { path, bytes, rows } of written) {
			const kept = rows.filter(([key]) => {
				const folded = selected.get(key);
				const current = this.overrides.get(key);
				return folded === undefined || current === folded || current?.kind === "patch";
			});
			if (kept.length === 0) {
				this.store.discard(path, bytes);
				continue;
			}
			const leaves = kept.flatMap(([, row]) => this.leavesOf(row));
			const page: Page = { path, bytes, keys: kept.map(([key]) => key), leaves, inBase: true, pins: 0 };
			for (const key of page.keys) pageOf.set(key, page);
			for (const id of leaves) this.store.adjust(id, 1, 0);
			published.push(page);
		}
		this.base = { pages: [...base.pages.filter((page) => !touched.has(page)), ...published], pageOf };
		for (const [key, override] of selected) {
			const current = this.overrides.get(key);
			if (current === override || (current?.kind === "tombstone" && !pageOf.has(key))) this.drop(key);
		}
		for (const page of touched) {
			page.inBase = false;
			if (page.pins === 0) this.reclaimPage(page, -1, 0);
			else for (const id of page.leaves) this.store.adjust(id, -1, 1);
		}
	}

	private async readPage(page: Page): Promise<[string, Row][]> {
		const data = await this.store.readFile(page.path, page.bytes, "page_read");
		const entries: [string, Row][] = JSON.parse(data.toString("utf8"));
		if (entries.length === page.keys.length) return entries;
		const keys = new Set(page.keys);
		return entries.filter(([key]) => keys.has(key));
	}

	private reclaimPage(page: Page, live: number, pins: number): void {
		for (const id of page.leaves) this.store.adjust(id, live, pins);
		this.store.discard(page.path, page.bytes);
	}

	private put(key: string, override: Override<Row>): void {
		const leaves = override.kind === "row" ? this.leavesOf(override.row) : [];
		for (const id of leaves) this.store.adjust(id, 1, 0);
		this.drop(key);
		this.overrides.set(key, override);
		this.unsettledLeaves.set(key, leaves);
		if (override.kind === "tombstone") this.countTombstone(key, 1);
		this.maybeCompact();
	}

	private drop(key: string): void {
		const old = this.overrides.get(key);
		if (!old) return;
		this.overrides.delete(key);
		this.unsettledLeaves.delete(key);
		if (old.kind === "row") {
			for (const id of this.leavesOf(old.row)) {
				this.store.adjust(id, -1, 0);
			}
		}
		if (old.kind === "tombstone") this.countTombstone(key, -1);
	}

	private countTombstone(key: string, delta: number): void {
		this.tombstones += delta;
		this.tombstoneKeyUnits += delta * key.length;
	}

	private pinRow(override: Override<Row>, delta: number): void {
		if (override.kind === "row") for (const id of this.leavesOf(override.row)) this.store.adjust(id, 0, delta);
	}
}

function applyOverrides<Row extends object>(
	rows: Map<string, Row>,
	overrides: ReadonlyMap<string, Override<Row>>,
): void {
	for (const [key, override] of overrides) {
		if (override.kind === "tombstone") rows.delete(key);
		else if (override.kind === "row") rows.set(key, override.row);
		else {
			const row = rows.get(key);
			if (row) rows.set(key, { ...row, ...override.patch });
		}
	}
}
