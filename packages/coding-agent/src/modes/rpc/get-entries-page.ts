/**
 * Bounded `get_entries` answers (senpi#3534). One response line rides the connection's event queue,
 * which fails the whole connection closed past 64 MiB (`socket-event-fanout.ts`), so a history read
 * is cut into pages a client walks with `since`, and an unpaged read that would not fit is refused
 * with `response_too_large` instead of taking the connection (and every session on it) down.
 */

/** The largest answer one unpaged read may produce: well under the 64 MiB connection queue bound. */
export const RPC_RESPONSE_BYTE_BUDGET = 48 * 1024 * 1024;
export const DEFAULT_ENTRY_PAGE_BYTES = 8 * 1024 * 1024;

export interface EntryPageRequest {
	readonly limit?: number;
	readonly maxBytes?: number;
}

export interface EntryPage<T> {
	readonly entries: T[];
	readonly hasMore: boolean;
	readonly nextSince?: string;
}

export type EntryPageBounds =
	| { readonly ok: true; readonly paged: boolean; readonly limit?: number; readonly maxBytes: number }
	| { readonly ok: false; readonly message: string };

export function entryPageBounds(request: EntryPageRequest): EntryPageBounds {
	const { limit, maxBytes } = request;
	if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
		return { ok: false, message: "limit must be a positive integer" };
	if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes > 0))
		return { ok: false, message: "maxBytes must be a positive integer" };
	if (limit === undefined && maxBytes === undefined)
		return { ok: true, paged: false, maxBytes: RPC_RESPONSE_BYTE_BUDGET };
	return {
		ok: true,
		paged: true,
		...(limit === undefined ? {} : { limit }),
		maxBytes: Math.min(maxBytes ?? DEFAULT_ENTRY_PAGE_BYTES, RPC_RESPONSE_BYTE_BUDGET),
	};
}

/**
 * Takes entries in order until the count or the serialized byte size would pass the bounds. The first
 * entry is always taken, so a page always moves the cursor forward even when one entry alone is larger
 * than `maxBytes`. Only the page is projected, so a large history never builds one giant answer.
 */
export function pageEntries<S extends { readonly id: string }, T>(
	entries: readonly S[],
	project: (entry: S) => T,
	bounds: { readonly limit?: number; readonly maxBytes: number },
): EntryPage<T> {
	const page: T[] = [];
	let bytes = 0;
	let taken = 0;
	for (const entry of entries) {
		if (bounds.limit !== undefined && taken >= bounds.limit) break;
		const projected = project(entry);
		const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
		if (taken > 0 && bytes + size > bounds.maxBytes) break;
		page.push(projected);
		bytes += size;
		taken++;
	}
	const last = entries[taken - 1];
	const hasMore = taken < entries.length;
	return { entries: page, hasMore, ...(hasMore && last !== undefined ? { nextSince: last.id } : {}) };
}
