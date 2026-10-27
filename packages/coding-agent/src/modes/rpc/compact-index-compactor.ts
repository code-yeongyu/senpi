import type { CompactContentIndex, IndexOverride, IndexPage, IndexRow } from "./compact-content-index.ts";
import { packPages } from "./compact-index-pages.ts";
import { CompactReadError } from "./compact-read-lease.ts";

type Index = Pick<
	CompactContentIndex<object>,
	| "store"
	| "values"
	| "bases"
	| "overlays"
	| "base"
	| "overrides"
	| "pages"
	| "pending"
	| "residentPages"
	| "peakResidentPages"
	| "readPage"
	| "freeze"
	| "release"
	| "drop"
	| "status"
>;

/** One bounded selection and one optional small page, with a single atomic representation swap. */
export class CompactIndexCompactor {
	private readonly index: Index;
	private readonly threshold: number;
	private running = false;

	constructor(index: Index, threshold: number) {
		this.index = index;
		this.threshold = threshold;
	}

	schedule(): void {
		const index = this.index;
		if (
			this.running ||
			!index.store.spillAllowed ||
			((index.overrides?.size ?? 0) - index.pending.size < this.threshold && !index.status().deletionMasks)
		)
			return;
		this.running = true;
		index.store.enqueue("page_write", async () => {
			let progress = false;
			try {
				progress = await index.bases.cached(() => this.compact());
			} finally {
				this.running = false;
			}
			if (progress) this.schedule();
		});
	}

	private async compact(): Promise<boolean> {
		const i = this.index;
		if (!i.store.spillAllowed) return false;
		if (i.pending.size) await i.store.flushValues();
		if (!i.store.spillAllowed) return false;
		const cut = i.freeze();
		const selected = new Map<string, IndexOverride>();
		let touched: IndexPage | undefined;
		const rows = new Map<string, IndexRow>();
		const removed = new Set<string>();
		const merged: number[] = [];
		const written: { page: IndexPage; keys: string[] }[] = [];
		const loaded: Awaited<ReturnType<Index["readPage"]>>[] = [];
		const unowned = new Set<IndexPage>();
		let draft = i.base;
		i.bases.adjust(draft, 1, 0);
		try {
			const entries = i.overlays.entries(cut.overrides);
			while (selected.size < 128) {
				const batch: (readonly [string, IndexOverride])[] = [];
				for (let n = 0; n < 128; n++) {
					const next = entries.next();
					if (next.done) break;
					batch.push(next.value);
				}
				if (!batch.length) break;
				const locations = await i.bases.getMany(
					cut.base,
					batch.map(([key]) => key),
				);
				for (const [key, value] of batch) {
					const page = locations.get(key)?.page;
					if (!i.pending.has(key) && (!page || !touched || page.path === touched.path)) {
						selected.set(key, value);
						touched ??= page;
					}
					if (selected.size === 128) break;
				}
			}
			let small: IndexPage | undefined;
			for (const page of i.pages) {
				if (page.count < 64 && page.bytes < 32_768) {
					small = page;
					break;
				}
			}
			for (const page of small?.path === touched?.path ? [small] : [small, touched]) {
				if (!page) continue;
				const data = await i.readPage(page);
				loaded.push(data);
				const keyed: [string, IndexRow][] = [];
				for (const row of data.rows) {
					const key = await i.values.read(row.key);
					if (typeof key !== "string") throw new CompactReadError("ownership");
					keyed.push([key, row]);
				}
				const locations = await i.bases.getMany(
					cut.base,
					keyed.map(([key]) => key),
				);
				for (const [key, row] of keyed) {
					if (locations.get(key)?.page.path === page.path) {
						rows.set(key, row);
						removed.add(key);
					}
				}
			}
			for (const [key, change] of selected) {
				removed.add(key);
				if (change.deleted) {
					rows.delete(key);
					continue;
				}
				let row = change.row ?? rows.get(key);
				if (row && change.patch.size) {
					const value = await i.values.merge(row.value, change.patch);
					merged.push(value.owner);
					row = { ...row, value };
				}
				if (row) rows.set(key, row);
			}
			const ordered = [...rows];
			let offset = 0;
			for (const chunk of packPages(ordered.map(([, row]) => row))) {
				const data = Buffer.from(JSON.stringify(chunk));
				i.peakResidentPages = Math.max(i.peakResidentPages, i.residentPages + 1);
				const path = await i.store.writeFile(data, "page_write", data.byteLength);
				if (path === undefined) return false;
				written.push({
					page: {
						path,
						bytes: data.byteLength,
						count: chunk.length,
						owner: 0,
					},
					keys: ordered.slice(offset, offset + chunk.length).map(([key]) => key),
				});
				unowned.add(written[written.length - 1].page);
				offset += chunk.length;
			}
			if (!i.store.spillAllowed) return false;
			for (const candidate of written) {
				const kept: [string, number][] = [];
				const refs: number[] = [];
				for (const [offset, key] of candidate.keys.entries()) {
					const row = rows.get(key);
					if (!row) throw new CompactReadError("ownership");
					// Even a concurrently removed row's on-disk key must survive page traversal.
					refs.push(row.key.owner);
					const folded = selected.get(key);
					const current = i.overlays.get(i.overrides, key);
					if (folded && current !== folded && (!current || current.deleted || current.row !== folded.row))
						continue;
					refs.push(row.value.owner, row.payload);
					kept.push([key, offset]);
				}
				const file = i.store.ownFile(candidate.page.path, candidate.page.bytes);
				const page = { ...candidate.page, owner: i.store.text.own([...refs, file]) };
				i.store.adjust(file, -1, 0);
				unowned.delete(candidate.page);
				try {
					for (const [key, offset] of kept) {
						const next = await i.bases.set(draft, key, { page, offset });
						i.bases.adjust(draft, -1, 0);
						draft = next;
						removed.delete(key);
					}
					if (kept.length) candidate.page = page;
				} finally {
					i.store.adjust(page.owner, -1, 0);
				}
			}
			for (const key of removed) {
				const next = await i.bases.set(draft, key, undefined);
				i.bases.adjust(draft, -1, 0);
				draft = next;
			}
			await i.bases.flush();
			if (!i.store.spillAllowed) return false;
			const previous = i.base;
			i.base = draft;
			draft = undefined;
			i.bases.adjust(previous, -1, 0);
			for (const page of i.pages) if (page.path === small?.path || page.path === touched?.path) i.pages.delete(page);
			for (const { page } of written) if (page.owner) i.pages.add(page);
			for (const [key, value] of selected) {
				const current = i.overlays.get(i.overrides, key);
				if (current === value) i.drop(key);
			}
			return selected.size > 0;
		} catch (error) {
			if (error instanceof CompactReadError && error.reason === "retired") return false;
			throw error;
		} finally {
			i.bases.adjust(draft, -1, 0);
			for (const page of loaded) page[Symbol.dispose]();
			for (const page of unowned) i.store.discard(page.path, page.bytes);
			for (const owner of merged) i.store.adjust(owner, -1, 0);
			i.release(cut);
		}
	}
}
