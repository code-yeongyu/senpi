import { type CatalogEntry, catalogDigest, catalogDigester, storedBytes } from "./compact-catalog-codec.ts";
import type { LeafId } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { ContentDigest } from "./compact-recovery-ids.ts";

/** D (R4.B3): the most raw bytes one fragment carries; its base64 (174,764) plus H (16,384) fits F (262,144). */
export const FRAGMENT_MAX_BYTES = 131_072;
/**
 * The page budget on the wire (RULING-69 (1)): the base64 envelope of a full fragment, derived from D (four characters
 * per three raw bytes, the last group padded); S12's initial worker credit is one such envelope (RULING-63).
 */
export const FRAGMENT_ENVELOPE_MAX_BYTES = Math.ceil(FRAGMENT_MAX_BYTES / 3) * 4;

/**
 * One frozen component as the byte stream the recovery pages address (S11a, RULING-46 item 2: the one byte
 * representation S11b, S12a and S13 reuse): its EXACT stored UTF-16LE bytes in leaf order (RULING-58 (1)), addressed by
 * raw byte offset, never by code unit or base64 character. `digest` is the catalog entry's `leaf` digest of the whole
 * stream, verified against the stored bytes before this exists (RULING-57 Q1 (3)); a range is served from the same
 * immutable leaves with at most one stored leaf resident beside the result.
 */
export interface FrozenBytes {
	readonly length: number;
	readonly digest: ContentDigest;
	/** The most stored leaves resident at once across every range read; a test instrument for RULING-59 A. */
	readonly peakResidentLeaves: number;
	range(offset: number, length: number, valid?: () => void): Promise<Buffer>;
}

/** One bounded page of a component's bytes: `digest` is the `fragment`-domain digest of exactly `bytes`. */
export interface RecoveryPage {
	readonly offset: number;
	readonly length: number;
	readonly bytes: Buffer;
	readonly digest: ContentDigest;
	readonly next: number | null;
	readonly complete: boolean;
}

type ReadLeaf = (leaf: LeafId) => Promise<string>;

const isIndex = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

class FrozenLeafBytes implements FrozenBytes {
	readonly length: number;
	readonly digest: ContentDigest;
	peakResidentLeaves = 0;
	private resident = 0;
	private readonly leaves: readonly LeafId[];
	/** `starts[i]` is the byte offset of leaf `i`; `starts[leaves.length]` is the total length. */
	private readonly starts: readonly number[];
	private readonly read: ReadLeaf;

	constructor(digest: ContentDigest, leaves: readonly LeafId[], starts: readonly number[], read: ReadLeaf) {
		this.length = starts[leaves.length] ?? 0;
		this.digest = digest;
		this.leaves = leaves;
		this.starts = starts;
		this.read = read;
	}

	async range(offset: number, length: number, valid?: () => void): Promise<Buffer> {
		if (!isIndex(offset) || !isIndex(length)) throw new CompactReadError("range");
		if (length > FRAGMENT_MAX_BYTES) throw new CompactReadError("size_limit");
		if (offset + length > this.length) throw new CompactReadError("range");
		const out = Buffer.allocUnsafe(length);
		let written = 0;
		for (let index = this.leafAt(offset); written < length; index++) {
			const leaf = this.leaves[index];
			const start = this.starts[index];
			if (leaf === undefined || start === undefined) throw new CompactReadError("integrity");
			this.peakResidentLeaves = Math.max(this.peakResidentLeaves, ++this.resident);
			try {
				const stored = storedBytes(await this.read(leaf));
				valid?.();
				const from = Math.max(0, offset - start);
				written += stored.copy(out, written, from, Math.min(stored.length, from + length - written));
			} finally {
				this.resident -= 1;
			}
		}
		return out;
	}

	/** The leaf whose byte range holds `offset`: the last start at or before it. */
	private leafAt(offset: number): number {
		let low = 0;
		let high = this.leaves.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if ((this.starts[middle] ?? Number.POSITIVE_INFINITY) <= offset) low = middle;
			else high = middle - 1;
		}
		return low;
	}
}

/**
 * Opens a component's stored leaves as `FrozenBytes` after verifying them, one leaf resident, against the catalog
 * entry's length and digest; a mismatch is `integrity` and no byte source exists. `valid` runs after every leaf read.
 * The verification belongs to the request that asked for it (RULING-69 (2)): once `signal` aborts, no further leaf is
 * read and the open is the typed `aborted`, holding nothing.
 */
export async function openFrozenBytes(
	entry: Pick<CatalogEntry, "length" | "digest">,
	leaves: readonly LeafId[],
	read: ReadLeaf,
	valid: () => void,
	signal?: AbortSignal,
): Promise<FrozenBytes> {
	const digester = catalogDigester("leaf", entry.length);
	const starts: number[] = [0];
	let fed = 0;
	for (const leaf of leaves) {
		if (signal?.aborted) throw new CompactReadError("aborted");
		const stored = storedBytes(await read(leaf));
		valid();
		fed += stored.length;
		if (fed > entry.length) throw new CompactReadError("integrity");
		digester.update(stored);
		starts.push(fed);
	}
	if (fed !== entry.length || digester.finish() !== entry.digest) throw new CompactReadError("integrity");
	return new FrozenLeafBytes(entry.digest, leaves, starts, read);
}

/**
 * The page at a raw byte offset: at most `FRAGMENT_MAX_BYTES` bytes, `next` the offset the following page starts at
 * (null once the stream is complete). An offset past the last byte is `range`; an empty component is one empty page.
 */
export async function producePage(bytes: FrozenBytes, offset: number, valid?: () => void): Promise<RecoveryPage> {
	if (!isIndex(offset) || (offset >= bytes.length && bytes.length > 0)) throw new CompactReadError("range");
	const length = Math.min(FRAGMENT_MAX_BYTES, bytes.length - offset);
	const page = await bytes.range(offset, length, valid);
	const next = offset + length;
	return {
		offset,
		length,
		bytes: page,
		digest: catalogDigest("fragment", page),
		next: next < bytes.length ? next : null,
		complete: next === bytes.length,
	};
}
