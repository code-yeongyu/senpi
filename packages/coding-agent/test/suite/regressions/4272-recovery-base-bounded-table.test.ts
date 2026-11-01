import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_TRANSCRIPT_ANCESTRY_BYTES } from "../../../src/modes/rpc/accepted-transcript.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import { type BaseBytes, openBaseBytes } from "../../../src/modes/rpc/compact-recovery-base.ts";
import { FRAGMENT_MAX_BYTES, producePage } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { type BaseEntry, fingerprintOf, stampedBytes, stampedRow, writeBase } from "./4272-base-file-support.ts";

// Part of #4272 (S11c, RULING-71 (2) and (4)): the per-row table the base open keeps is charged against a stated
// budget (RULING-61's 8 MiB transcript ancestry budget): 20 B per anchor plus the closing stream offset. Up to the
// budget every row is an anchor (dense); above it every k-th row is, with k the least that fits, and a range re-derives
// at most the k rows of each anchor group it touches. A large transcript is never refused. idFingerprint covers ids
// only, so a row whose content changed under unchanged ids is caught by the per-group check on every page.

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-base-table-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** The spec, restated: 20 B per anchor (stream start, file start, 32-bit hash) plus one closing 8 B stream offset. */
const tableBytes = (anchors: number): number => anchors * 20 + 8;
const rowsPerAnchor = (count: number, budget: number): number =>
	Math.max(1, Math.ceil(count / Math.floor((budget - 8) / 20)));

const chain = (count: number): BaseEntry[] => {
	const entries: BaseEntry[] = [{ type: "session", id: "s0" }];
	for (let index = 1; index < count; index++)
		entries.push({
			type: index % 7 === 0 ? "custom" : "message",
			id: `entry-${index}`,
			parentId: `entry-${index - 1}`,
		});
	return entries;
};

/** The raw byte offset of row `index` in the stamped stream. */
const rowOffset = (entries: readonly BaseEntry[], index: number): number =>
	entries.slice(0, index).reduce((sum, entry, at) => sum + Buffer.byteLength(stampedRow(at, entry), "utf16le"), 0);

/** Every page in order, joined (a test-side join the production path never makes). */
async function pagesOf(bytes: BaseBytes): Promise<Buffer[]> {
	const pages: Buffer[] = [];
	for (let offset: number | null = 0; offset !== null;) {
		const page = await producePage(bytes, offset);
		pages.push(page.bytes);
		offset = page.next;
	}
	return pages;
}

async function refusalOf(read: Promise<Buffer>): Promise<string | undefined> {
	try {
		await read;
		return undefined;
	} catch (cause) {
		if (cause instanceof CompactReadError) return cause.reason;
		throw cause;
	}
}

it("RULING-71 (2) up to the budget the table is dense, one anchor per row; one row over it, the table goes sparse instead of refusing", async () => {
	// Given: a base of five entries and a budget exactly the dense table's size, then one byte less
	const entries = chain(5);
	const base = await writeBase(join(dir, "s.jsonl"), entries);
	const dense = await openBaseBytes(base, () => undefined, undefined, tableBytes(5));
	const sparse = await openBaseBytes(base, () => undefined, undefined, tableBytes(5) - 1);
	// Then: exactly one table each, within its budget, and both serve the whole stream byte-exact
	expect([dense.rowsPerAnchor, dense.tableBytes]).toEqual([1, tableBytes(5)]);
	expect([sparse.rowsPerAnchor, sparse.tableBytes]).toEqual([2, tableBytes(3)]);
	for (const bytes of [dense, sparse])
		expect(Buffer.concat(await pagesOf(bytes)).equals(stampedBytes(entries))).toBe(true);
	// And: the default budget is RULING-61's 8 MiB ancestry budget
	const fallback = await openBaseBytes(base, () => undefined);
	expect([fallback.rowsPerAnchor, fallback.tableBytes]).toEqual([1, tableBytes(5)]);
	expect(rowsPerAnchor(419_430, DEFAULT_TRANSCRIPT_ANCESTRY_BYTES), "8 MiB holds 419,430 dense rows").toBe(1);
	expect(rowsPerAnchor(419_431, DEFAULT_TRANSCRIPT_ANCESTRY_BYTES)).toBe(2);
});

it("RULING-71 (2) a base above the budget keeps one bounded sparse table, serves every page byte-exact, and re-derives at most one anchor group per edge", async () => {
	// Given: 1,400 entries (stamped rows over D) under a budget of 100 anchors
	const entries = chain(1_400);
	const base = await writeBase(join(dir, "s.jsonl"), entries);
	const budget = tableBytes(100);
	const bytes = await openBaseBytes(base, () => undefined, undefined, budget);
	// Then: one table of every 14th row, within the budget
	expect(bytes.rowsPerAnchor).toBe(rowsPerAnchor(1_400, budget));
	expect(bytes.rowsPerAnchor).toBe(14);
	expect(bytes.tableBytes).toBe(tableBytes(100));
	expect(bytes.tableBytes).toBeLessThanOrEqual(budget);
	// When: a two-byte range inside row 50 is read
	await bytes.range(rowOffset(entries, 50), 2);
	// Then: only the anchor group holding it (rows 42..55) was re-derived
	expect(bytes.peakRangeRows).toBe(14);
	// When: every page is produced in order
	const expected = stampedBytes(entries);
	const pages = await pagesOf(bytes);
	// Then: the join is exact, one line was resident at a time, and no range re-derived more than its rows plus 2k
	expect(pages.length).toBe(Math.ceil(expected.length / FRAGMENT_MAX_BYTES));
	expect(Buffer.concat(pages).equals(expected)).toBe(true);
	expect(bytes.peakResidentLeaves).toBe(1);
	const shortestRow = Buffer.byteLength(stampedRow(0, entries[0] ?? { type: "", id: "" }), "utf16le");
	expect(bytes.peakRangeRows).toBeLessThanOrEqual(Math.ceil(FRAGMENT_MAX_BYTES / shortestRow) + 2 * 14);
	// And: the smallest legal budget (one anchor for the whole base) still serves it, never a refusal
	const single = await openBaseBytes(base, () => undefined, undefined, tableBytes(1));
	expect([single.rowsPerAnchor, single.tableBytes]).toEqual([1_400, tableBytes(1)]);
	expect(Buffer.concat(await pagesOf(single)).equals(expected)).toBe(true);
});

it.each([
	["dense", DEFAULT_TRANSCRIPT_ANCESTRY_BYTES, 1],
	["sparse", tableBytes(100), 14],
])(
	"RULING-71 (4) same ids, one row's content changed to the same length, is refused on the %s table",
	async (_label, budget, k) => {
		// Given: an open base, and the file then rewritten in place with row 50's parent changed (same ids, same length)
		const path = join(dir, "s.jsonl");
		const entries = chain(1_400);
		const base = await writeBase(path, entries);
		const bytes = await openBaseBytes(base, () => undefined, undefined, budget);
		expect(bytes.rowsPerAnchor).toBe(k);
		expect(50 % k === 0 && k > 1, "the changed row lies between anchors").toBe(false);
		const changed = entries.map((entry, index) => (index === 50 ? { ...entry, parentId: "entry-48" } : entry));
		const original = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const rewritten = `${changed.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		expect(rewritten.length).toBe(original.length);
		expect(fingerprintOf(changed), "idFingerprint covers ids, not content").toBe(base.idFingerprint);
		await writeFile(path, rewritten);
		// Then: the page holding the changed row is the typed mismatch
		expect(await refusalOf(bytes.range(rowOffset(entries, 50), 2))).toBe("base_fingerprint_mismatch");
		// And: a neighbour in the same anchor group is refused too (the group is verified whole); on the dense table the
		// neighbour is its own group and is served unchanged
		const neighbour = bytes.range(rowOffset(entries, 43), 2);
		if (k === 1)
			expect(
				(await neighbour).equals(
					stampedBytes(entries).subarray(rowOffset(entries, 43), rowOffset(entries, 43) + 2),
				),
			).toBe(true);
		else expect(await refusalOf(neighbour)).toBe("base_fingerprint_mismatch");
	},
);
