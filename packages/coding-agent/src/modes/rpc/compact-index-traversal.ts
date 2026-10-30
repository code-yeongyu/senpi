import type { CompactContentIndex, FrozenIndex, IndexCursor, IndexPage, IndexRow } from "./compact-content-index.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { ValueRef } from "./compact-values.ts";

/** At most 128 descriptors; the index owns the surrounding operation lease. */
export async function readIndexPage(
	index: Pick<CompactContentIndex<object>, "bases" | "overlays" | "readPage" | "store">,
	cut: FrozenIndex,
	cursor?: IndexCursor,
) {
	if (cursor && cursor.cut !== cut) throw new CompactReadError("ownership");
	const rows: { row: IndexRow; patch: ValueRef | undefined }[] = [];
	const base = index.bases.entries(cut.base, cursor?.after);
	const overlay = index.overlays.entries(cut.overrides, cursor?.after);
	let a = await base.next(),
		b = overlay.next(),
		last: string | undefined;
	let loaded: Awaited<ReturnType<typeof index.readPage>> | undefined;
	let from: IndexPage | undefined;
	try {
		while ((!a.done || !b.done) && rows.length < 128) {
			const key = a.done ? b.value?.[0] : b.done ? a.value[0] : a.value[0] < b.value[0] ? a.value[0] : b.value[0];
			if (key === undefined) break;
			const old = !a.done && a.value[0] === key ? a.value[1] : undefined;
			const change = !b.done && b.value[0] === key ? b.value[1] : undefined;
			if (!change?.deleted) {
				if (!change?.row && old && from?.path !== old.page.path) {
					loaded?.[Symbol.dispose]();
					loaded = undefined;
					from = old.page;
					loaded = await index.readPage(from);
				}
				const row = change?.row ?? (old ? loaded?.rows[old.offset] : undefined);
				if (row) rows.push({ row, patch: change?.patchValue });
			}
			last = key;
			if (!a.done && a.value[0] === key) a = await base.next();
			if (!b.done && b.value[0] === key) b = overlay.next();
		}
	} finally {
		loaded?.[Symbol.dispose]();
	}
	index.store.assertReadable();
	if (Buffer.byteLength(JSON.stringify(rows)) > 65_536) throw new CompactReadError("size_limit");
	return { rows, next: (a.done && b.done) || last === undefined ? undefined : { cut, after: last } };
}

/** Compatibility assembly runs under the index's operation lease; recovery consumes descriptors. */
export async function readIndexEntries<Row extends object>(
	index: Pick<CompactContentIndex<Row>, "page" | "values">,
	cut: FrozenIndex,
): Promise<Map<string, Row>> {
	const result = new Map<string, Row>();
	let after: IndexCursor | undefined;
	for (;;) {
		const page = await index.page(cut, after);
		for (const entry of page.rows) {
			const value = await index.values.read(entry.row.value);
			const row: Row = JSON.parse(JSON.stringify(value));
			if (entry.patch) Object.assign(row, await index.values.read(entry.patch));
			const key = await index.values.read(entry.row.key);
			if (typeof key !== "string") throw new CompactReadError("ownership");
			result.set(key, row);
		}
		if (!page.next) return result;
		after = page.next;
	}
}
