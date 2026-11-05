import { CompactWriteError } from "./compact-content-store.ts";

/** Incremental descriptor packing; values and keys must already be references. */
export function* packPages<Row>(rows: Iterable<Row>): Generator<Row[]> {
	let page: Row[] = [];
	let bytes = 2;
	for (const row of rows) {
		const size = Buffer.byteLength(JSON.stringify(row));
		if (size + 2 > 65_536) throw new CompactWriteError("size_limit");
		if (page.length === 128 || bytes + size + Number(page.length > 0) > 65_536) {
			yield page;
			page = [];
			bytes = 2;
		}
		bytes += size + Number(page.length > 0);
		page.push(row);
	}
	if (page.length) yield page;
}
