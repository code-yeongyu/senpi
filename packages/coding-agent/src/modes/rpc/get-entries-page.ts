/**
 * Bounded `get_entries` answers (senpi#3534). One response line rides the connection's event queue,
 * which fails the whole connection closed past 64 MiB (`socket-event-fanout.ts`), so a history read
 * is cut into pages a client walks with `since`, and an unpaged read that would not fit is refused
 * with `response_too_large` instead of taking the connection (and every session on it) down.
 */

/** The largest answer one unpaged read may produce: well under the 64 MiB connection queue bound. */
export const RPC_RESPONSE_BYTE_BUDGET = 48 * 1024 * 1024;
export const DEFAULT_ENTRY_PAGE_BYTES = 8 * 1024 * 1024;
/** How long a page walk may pause before the full-history view it holds is let go. */
export const ENTRY_WALK_HOLD_MS = 30_000;

let responseByteBudget = RPC_RESPONSE_BYTE_BUDGET;

/** The byte budget one answer may use; tests lower it to reach the refusal without a 48 MiB history. */
export function currentResponseByteBudget(): number {
	return responseByteBudget;
}

export function setResponseByteBudgetForTesting(bytes: number): () => void {
	const previous = responseByteBudget;
	responseByteBudget = bytes;
	return () => {
		responseByteBudget = previous;
	};
}

export interface EntryPageRequest {
	readonly limit?: number;
	/** The newest `tail` entries of the range, read backwards (senpi#4267); never combined with `limit`. */
	readonly tail?: number;
	readonly maxBytes?: number;
}

export interface EntryPage<T> {
	readonly entries: T[];
	readonly hasMore: boolean;
	readonly nextSince?: string;
	/** Serialized size of the page's first entry (0 for an empty page): one entry past the budget cannot be sent. */
	readonly firstEntryBytes: number;
}

export type EntryPageBounds =
	| {
			readonly ok: true;
			readonly paged: boolean;
			readonly limit?: number;
			readonly tail?: number;
			readonly maxBytes: number;
	  }
	| { readonly ok: false; readonly message: string };

export function entryPageBounds(request: EntryPageRequest): EntryPageBounds {
	const { limit, tail, maxBytes } = request;
	if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
		return { ok: false, message: "limit must be a positive integer" };
	if (tail !== undefined && !(Number.isInteger(tail) && tail > 0))
		return { ok: false, message: "tail must be a positive integer" };
	if (limit !== undefined && tail !== undefined)
		return { ok: false, message: "limit and tail cannot be combined: limit pages forward, tail backward" };
	if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes > 0))
		return { ok: false, message: "maxBytes must be a positive integer" };
	if (limit === undefined && tail === undefined && maxBytes === undefined)
		return { ok: true, paged: false, maxBytes: responseByteBudget };
	return {
		ok: true,
		paged: true,
		...(limit === undefined ? {} : { limit }),
		...(tail === undefined ? {} : { tail }),
		maxBytes: Math.min(maxBytes ?? DEFAULT_ENTRY_PAGE_BYTES, responseByteBudget),
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
	let firstEntryBytes = 0;
	for (const entry of entries) {
		if (bounds.limit !== undefined && taken >= bounds.limit) break;
		const projected = project(entry);
		const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
		if (taken > 0 && bytes + size > bounds.maxBytes) break;
		if (taken === 0) firstEntryBytes = size;
		page.push(projected);
		bytes += size;
		taken++;
	}
	const last = entries[taken - 1];
	const hasMore = taken < entries.length;
	return {
		entries: page,
		hasMore,
		...(hasMore && last !== undefined ? { nextSince: last.id } : {}),
		firstEntryBytes,
	};
}

export interface TailEntryPage<T> {
	/** In append order: the oldest of the page first. */
	readonly entries: T[];
	readonly hasMore: boolean;
	/** The oldest entry id the page returned, while older entries remain: pass it as the next `before`. */
	readonly nextBefore?: string;
	/** Serialized size of the page's newest entry (0 for an empty page). */
	readonly firstEntryBytes: number;
}

/**
 * The newest entries first, until the count or the byte size would pass the bounds, answered in append order. The
 * newest entry is always taken, so a backward walk always moves even when one entry alone is larger than `maxBytes`.
 */
export function pageEntriesFromEnd<S extends { readonly id: string }, T>(
	entries: readonly S[],
	project: (entry: S) => T,
	bounds: { readonly tail?: number; readonly maxBytes: number },
): TailEntryPage<T> {
	const page: T[] = [];
	let bytes = 0;
	let firstEntryBytes = 0;
	let index = entries.length - 1;
	for (; index >= 0; index--) {
		if (bounds.tail !== undefined && page.length >= bounds.tail) break;
		const entry = entries[index];
		if (entry === undefined) break;
		const projected = project(entry);
		const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
		if (page.length > 0 && bytes + size > bounds.maxBytes) break;
		if (page.length === 0) firstEntryBytes = size;
		page.push(projected);
		bytes += size;
	}
	page.reverse();
	const oldest = entries[index + 1];
	const hasMore = index >= 0;
	return {
		entries: page,
		hasMore,
		...(hasMore && oldest !== undefined ? { nextBefore: oldest.id } : {}),
		firstEntryBytes,
	};
}

const heldWalks = new WeakMap<object, ReturnType<typeof setTimeout>>();

/**
 * Keeps a page walk's full-history view for the next page, and lets it go after `ENTRY_WALK_HOLD_MS` without
 * one: a client that stops mid-walk must not pin the whole history of a session that is already idle.
 */
export function holdEntryWalk(owner: object, release: () => void): void {
	endEntryWalk(owner);
	const timer = setTimeout(() => {
		heldWalks.delete(owner);
		release();
	}, ENTRY_WALK_HOLD_MS);
	timer.unref?.();
	heldWalks.set(owner, timer);
}

export function endEntryWalk(owner: object): void {
	const timer = heldWalks.get(owner);
	if (timer === undefined) return;
	clearTimeout(timer);
	heldWalks.delete(owner);
}
