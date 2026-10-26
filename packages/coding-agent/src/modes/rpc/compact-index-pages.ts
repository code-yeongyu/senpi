/**
 * Page layout of the compact settled-row index (senpi#4272): how folded rows are packed into
 * copy-on-write page files, and which base pages are small enough to merge on the next compaction.
 */

const PAGE_ROWS = 128;
const PAGE_BYTES = 64 * 1024;

/** A page under half full in both rows and bytes is rewritten by the next compaction, so pages merge. */
export function isSmallPage(page: { readonly keys: readonly string[]; readonly bytes: number }): boolean {
	return page.keys.length < PAGE_ROWS / 2 && page.bytes < PAGE_BYTES / 2;
}

/** Packs entries into pages of at most `PAGE_ROWS` rows and `PAGE_BYTES` UTF-8 bytes (one oversized row stands alone). */
export function packPages<Row>(rows: readonly [string, Row][]): [string, Row][][] {
	const pages: [string, Row][][] = [];
	let page: [string, Row][] = [];
	// UTF-8 bytes of the serialized page: the brackets, plus each entry and its separator.
	let bytes = 1;
	for (const entry of rows) {
		const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
		if (page.length > 0 && (page.length === PAGE_ROWS || bytes + size > PAGE_BYTES)) {
			pages.push(page);
			page = [];
			bytes = 1;
		}
		page.push(entry);
		bytes += size;
	}
	if (page.length > 0) pages.push(page);
	return pages;
}
