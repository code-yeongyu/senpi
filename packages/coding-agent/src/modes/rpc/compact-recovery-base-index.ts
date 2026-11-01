import { DEFAULT_TRANSCRIPT_ANCESTRY_BYTES } from "./accepted-transcript.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { startAtOrBefore } from "./compact-recovery-bytes.ts";

/**
 * The row table the base open keeps (S11c, RULING-71 (2)): charged against a stated budget, never grown past it, and
 * never a reason to refuse a large transcript. Rows are grouped by `k` consecutive rows; each group's first row is an
 * anchor holding its stream start (8 B), its line's file start (8 B) and the FNV-1a-32 of the group's stamped rows
 * (4 B), plus one closing 8 B stream offset: `20 x anchors + 8` bytes. `k` is the least that fits the budget,
 * `k = max(1, ceil(count / floor((budget - 8) / 20)))`, so up to the budget every row is an anchor (the dense table,
 * one hash per row) and above it every k-th row is (the sparse table). A range re-derives rows from the anchor at or
 * before its offset to the end of the group holding its last byte: at most `k - 1` rows on each edge beyond its own,
 * and every group it touches is checked whole, so a row changed between anchors is refused like a changed anchor.
 * The hash is change detection for the user's local file only (see `compact-recovery-base.ts`).
 */
const ANCHOR_BYTES = 20;
const CLOSING_BYTES = 8;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** The base row table's budget: RULING-61's 8 MiB transcript ancestry budget (419,430 dense rows). */
export const BASE_ROW_TABLE_BYTES = DEFAULT_TRANSCRIPT_ANCESTRY_BYTES;

/** A line's byte span in the session file. */
export interface LineSpan {
	readonly start: number;
	readonly end: number;
}

/**
 * One in-order pass over rows from an anchor: `record` fills the table at the open, `verify` checks a page's rows
 * against it. `add` folds the next row in and reports whether it closed its group (checked whole in `verify`).
 */
export interface RowWalk {
	readonly row: number;
	readonly at: number;
	readonly fileStart: number;
	add(line: LineSpan, row: Buffer): boolean;
}

function fnv1a(hash: number, bytes: Buffer): number {
	let next = hash;
	for (let index = 0; index < bytes.length; index++) next = Math.imul(next ^ (bytes[index] ?? 0), FNV_PRIME) >>> 0;
	return next;
}

export class BaseRowTable {
	readonly rowsPerAnchor: number;
	readonly count: number;
	private readonly anchors: number;
	private readonly starts: Float64Array;
	private readonly fileStarts: Float64Array;
	private readonly hashes: Uint32Array;
	/** Where the last counted line ends: a file shorter than this is truncated under the cut. */
	fileEnd = 0;

	constructor(count: number, budget: number = BASE_ROW_TABLE_BYTES) {
		const fits = Math.floor((budget - CLOSING_BYTES) / ANCHOR_BYTES);
		if (!Number.isSafeInteger(fits) || fits < 1) throw new RangeError(`base row table budget too small: ${budget}`);
		this.count = count;
		this.rowsPerAnchor = Math.max(1, Math.ceil(count / fits));
		this.anchors = Math.ceil(count / this.rowsPerAnchor);
		this.starts = new Float64Array(this.anchors + 1);
		this.fileStarts = new Float64Array(this.anchors);
		this.hashes = new Uint32Array(this.anchors);
	}

	/** The table's charge against its budget: `20 x anchors + 8`. */
	get tableBytes(): number {
		return this.starts.byteLength + this.fileStarts.byteLength + this.hashes.byteLength;
	}

	/** The stamped stream's length, known once the open recorded every row. */
	get length(): number {
		return this.starts[this.anchors] ?? 0;
	}

	/** A pass from the anchor at or before `offset` (the open records from 0). */
	walk(offset: number, mode: "record" | "verify"): RowWalk {
		const table = this;
		const k = this.rowsPerAnchor;
		let group = mode === "record" ? 0 : startAtOrBefore(this.starts, this.anchors, offset);
		let hash = FNV_OFFSET;
		const mismatch = () => new CompactReadError("base_fingerprint_mismatch");
		return {
			row: group * k,
			at: this.starts[group] ?? 0,
			fileStart: this.fileStarts[group] ?? 0,
			add(line: LineSpan, row: Buffer): boolean {
				if (this.row % k === 0) {
					if (mode === "record") {
						table.fileStarts[group] = line.start;
						table.starts[group] = this.at;
					} else if (line.start !== table.fileStarts[group]) throw mismatch();
					hash = FNV_OFFSET;
				}
				hash = fnv1a(hash, row);
				Object.assign(this, { row: this.row + 1, at: this.at + row.length });
				if (mode === "record") table.fileEnd = line.end;
				if (this.row % k !== 0 && this.row !== table.count) return false;
				if (mode === "record") {
					table.hashes[group] = hash;
					table.starts[group + 1] = this.at;
				} else if (hash !== table.hashes[group] || this.at !== table.starts[group + 1]) throw mismatch();
				group += 1;
				return true;
			},
		};
	}
}
