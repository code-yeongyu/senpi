import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { z } from "zod";
import type { PersistedBase } from "../../core/session-transcript-journal.ts";
import type { TranscriptRoot } from "./accepted-transcript.ts";
import { storedBytes } from "./compact-catalog-codec.ts";
import { entryFamily } from "./compact-catalog-registry.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { assertRange, type FrozenBytes, startAtOrBefore } from "./compact-recovery-bytes.ts";
import {
	type BaseRef,
	baseRef,
	type ContentDigest,
	type ContentRef,
	parseContentDigest,
} from "./compact-recovery-ids.ts";

/**
 * The loaded transcript base as the page route streams it (S11c, RULING-70 (1) B, RULING-61 "partial -> exact"): one
 * stamped row per base entry, `{index, id, source: "file", parentId, kind, family}` plus a newline, in the ONE
 * UTF-16LE codec every component uses, so a page of it is a page like any other (`fragment` digest over its raw
 * bytes). The anchor is the cut's `idFingerprint` and file identity, never a catalog leaf: the open scans the file
 * once with one line resident, refuses typed unless the identity, the count and the fingerprint all hold, and keeps
 * per row only its stream start, its line's file start and a 32-bit hash of the row (20 bytes per entry, freed with
 * the root's lease). Every page re-opens the file by path, re-checks the identity and re-derives its rows from their
 * lines: a file that changed since the cut (replaced, truncated, missing, or rewritten so a row no longer hashes) is a
 * typed `PersistedBaseError`, never a stale byte. The recovery owner reads the file only here and only asynchronously
 * (RULING-50 (3)).
 */
const READ_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

const EntryLineSchema = z.object({ type: z.string(), id: z.string(), parentId: z.string().nullable().optional() });
type EntryLine = z.infer<typeof EntryLineSchema>;

interface Line {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

interface RowTable {
	readonly starts: Float64Array;
	readonly fileStarts: Float64Array;
	readonly hashes: Uint32Array;
	readonly fileEnd: number;
}

/** The base this cut's reserved ref names; another cut's ref, an unavailable transcript or no base is `range`. */
export function baseStream(transcript: TranscriptRoot, catalogRoot: ContentRef, ref: BaseRef): PersistedBase {
	const base = transcript.base;
	if (ref !== baseRef(catalogRoot) || transcript.unavailable !== null || base === null || base.count === 0)
		throw new CompactReadError("range");
	return base;
}

async function openIdentified(base: PersistedBase, end?: number): Promise<FileHandle> {
	let handle: FileHandle;
	try {
		handle = await open(base.fileIdentity.path, "r");
	} catch (cause) {
		if (cause instanceof Error) throw new CompactReadError("base_file_missing");
		throw cause;
	}
	try {
		const stat = await handle.stat({ bigint: true });
		if (String(stat.dev) !== base.fileIdentity.dev || String(stat.ino) !== base.fileIdentity.ino)
			throw new CompactReadError("base_file_replaced");
		if (end !== undefined && stat.size < BigInt(end)) throw new CompactReadError("base_file_truncated");
		return handle;
	} catch (cause) {
		await handle.close();
		throw cause;
	}
}

/** Each line from `from` with its byte span (the last one unterminated); one read buffer and one line resident. */
async function* lines(handle: FileHandle, from: number, check: () => void): AsyncGenerator<Line> {
	const buffer = Buffer.allocUnsafe(READ_BYTES);
	let carried: Buffer[] = [];
	let start = from;
	let position = from;
	for (;;) {
		const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, position);
		check();
		if (bytesRead === 0) break;
		const chunk = buffer.subarray(0, bytesRead);
		let at = 0;
		for (let newline = chunk.indexOf(NEWLINE); newline !== -1; newline = chunk.indexOf(NEWLINE, at)) {
			const end = position + newline;
			yield { start, end, text: Buffer.concat([...carried, chunk.subarray(at, newline)]).toString("utf8") };
			carried = [];
			at = newline + 1;
			start = end + 1;
		}
		if (at < bytesRead) carried.push(Buffer.from(chunk.subarray(at)));
		position += bytesRead;
	}
	if (carried.length > 0) yield { start, end: position, text: Buffer.concat(carried).toString("utf8") };
}

/** A blank or unparsable line is skipped as the loader skips it; a parsable one that is no entry cannot be stamped. */
function parseLine(text: string): EntryLine | undefined {
	if (text.trim() === "") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		if (cause instanceof SyntaxError) return undefined;
		throw cause;
	}
	const entry = EntryLineSchema.safeParse(value);
	if (!entry.success) throw new CompactReadError("base_fingerprint_mismatch");
	return entry.data;
}

const stampedRow = (index: number, entry: EntryLine): Buffer =>
	storedBytes(
		`${JSON.stringify({
			index,
			id: entry.id,
			source: "file",
			parentId: entry.parentId ?? null,
			kind: entry.type,
			family: entryFamily(entry.type),
		})}\n`,
	);

/** FNV-1a over a row's stored bytes: the 32 bits per row a page re-derivation is checked against. */
function rowHash(row: Buffer): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < row.length; index++) hash = Math.imul(hash ^ (row[index] ?? 0), 0x01000193) >>> 0;
	return hash;
}

class FrozenBaseBytes implements FrozenBytes {
	readonly length: number;
	readonly digest: ContentDigest;
	/** The most lines materialized at once while serving ranges: one, beside the read buffer. */
	peakResidentLeaves = 0;
	private resident = 0;
	private readonly base: PersistedBase;
	private readonly rows: RowTable;

	constructor(base: PersistedBase, digest: ContentDigest, rows: RowTable) {
		this.base = base;
		this.digest = digest;
		this.rows = rows;
		this.length = rows.starts[base.count] ?? 0;
	}

	async range(offset: number, length: number, valid?: () => void): Promise<Buffer> {
		assertRange(offset, length, this.length);
		const out = Buffer.allocUnsafe(length);
		const handle = await openIdentified(this.base, this.rows.fileEnd);
		try {
			let index = startAtOrBefore(this.rows.starts, this.base.count, offset);
			let written = 0;
			for await (const line of lines(handle, this.rows.fileStarts[index] ?? 0, () => valid?.())) {
				const entry = parseLine(line.text);
				if (!entry) continue;
				this.peakResidentLeaves = Math.max(this.peakResidentLeaves, ++this.resident);
				try {
					const row = this.verifiedRow(index, line.start, entry);
					const from = Math.max(0, offset - (this.rows.starts[index] ?? 0));
					written += row.copy(out, written, from, Math.min(row.length, from + length - written));
				} finally {
					this.resident -= 1;
				}
				if (written === length) return out;
				index += 1;
			}
			throw new CompactReadError("base_file_truncated");
		} finally {
			await handle.close();
		}
	}

	/** The row re-derived from its line must start where the open found it and hash as the open hashed it. */
	private verifiedRow(index: number, lineStart: number, entry: EntryLine): Buffer {
		const row = stampedRow(index, entry);
		const stamped = (this.rows.starts[index + 1] ?? 0) - (this.rows.starts[index] ?? 0);
		if (
			lineStart !== this.rows.fileStarts[index] ||
			row.length !== stamped ||
			rowHash(row) !== this.rows.hashes[index]
		)
			throw new CompactReadError("base_fingerprint_mismatch");
		return row;
	}
}

/**
 * Opens the base's stamped rows as `FrozenBytes` after one verifying scan of the file: `count` entries must be there
 * and fingerprint as the cut captured, else a typed `PersistedBaseError` and no source exists. The scan belongs to the
 * request that asked for it (RULING-69 (2)): once `signal` aborts no further read happens and the open is `aborted`;
 * `valid` runs after every read of the file.
 */
export async function openBaseBytes(
	base: PersistedBase,
	valid: () => void,
	signal?: AbortSignal,
): Promise<FrozenBytes> {
	const check = () => {
		if (signal?.aborted) throw new CompactReadError("aborted");
		valid();
	};
	const handle = await openIdentified(base);
	try {
		const starts = new Float64Array(base.count + 1);
		const fileStarts = new Float64Array(base.count);
		const hashes = new Uint32Array(base.count);
		const fingerprint = createHash("sha256");
		let count = 0;
		let fileEnd = 0;
		for await (const line of lines(handle, 0, check)) {
			const entry = parseLine(line.text);
			if (!entry) continue;
			const row = stampedRow(count, entry);
			fingerprint.update(`${entry.type}\u0000${entry.id}\n`);
			fileStarts[count] = line.start;
			hashes[count] = rowHash(row);
			starts[count + 1] = (starts[count] ?? 0) + row.length;
			fileEnd = line.end;
			if (++count === base.count) break;
		}
		if (count < base.count) throw new CompactReadError("base_file_truncated");
		const digest = parseContentDigest(fingerprint.digest("hex"));
		if (!digest.ok || digest.value !== base.idFingerprint) throw new CompactReadError("base_fingerprint_mismatch");
		return new FrozenBaseBytes(base, digest.value, { starts, fileStarts, hashes, fileEnd });
	} finally {
		await handle.close();
	}
}
