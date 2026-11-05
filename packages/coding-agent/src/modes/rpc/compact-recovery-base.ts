import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { parseSessionEntryLine } from "../../core/session-entry-file.ts";
import { BaseContentHash } from "../../core/session-file-identity.ts";
import type { FileEntry } from "../../core/session-manager.ts";
import { fingerprintLine, type PersistedBase } from "../../core/session-transcript-journal.ts";
import type { TranscriptRoot } from "./accepted-transcript.ts";
import { storedBytes } from "./compact-catalog-codec.ts";
import { entryFamily } from "./compact-catalog-registry.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { BASE_ROW_TABLE_BYTES, BaseRowTable, type LineSpan } from "./compact-recovery-base-index.ts";
import { assertRange, type FrozenBytes } from "./compact-recovery-bytes.ts";
import { type BaseRef, baseRef, type ContentRef, parseContentDigest } from "./compact-recovery-ids.ts";

/**
 * The loaded transcript base as the page route streams it (S11c, RULING-70 (1) B, RULING-61 "partial -> exact"): one
 * stamped row per base entry, `{index, id, source: "file", parentId, kind, family}` plus a newline, in the ONE
 * UTF-16LE codec every component uses, so a page of it is a page like any other (`fragment` digest over its raw
 * bytes). The anchor is the cut's file identity, `idFingerprint` and `contentFingerprint` (RULING-72: the counted
 * lines as the load read them, `BaseContentHash`), never a catalog leaf: the open scans the file once with one line
 * resident, refuses typed unless the identity, the count and both fingerprints hold, and keeps a row table bounded by
 * its budget (`compact-recovery-base-index.ts`, RULING-71 (2)), freed with the root's lease. Every page re-opens the
 * file by path, re-checks the identity and re-derives its rows from their lines. So ANY change to the base since the
 * load, to an id or to content, before or after the first page, is a typed `PersistedBaseError`, never a stale byte.
 * The recovery owner reads the file only here and only asynchronously (RULING-50 (3)).
 *
 * The scan reads lines exactly as the loader does (`parseSessionEntryLine`, `fingerprintLine`): every base the loader
 * accepted streams. A parsed line that is not a session entry is a row like any other, retained, never dropped
 * (RULING-60 Q1 (2)): its `kind` and `id` are the loader's string forms of its `type` and `id` (`"undefined"` when
 * absent, so the rows still re-derive `idFingerprint`), its `parentId` is null unless a string, and its family is its
 * kind's (`opaque` for an unknown one).
 *
 * What each check proves (RULING-71 (3), (4)):
 * - `idFingerprint` (SHA-256 over `kind NUL id LF` per entry) covers the entries' ids and kinds, NOT their content:
 *   a parent changed under unchanged ids passes it. A content change between the load and the open is caught by
 *   `contentFingerprint` at the open; one after the open by the per-row check on every page (each re-derived row
 *   must start, measure and hash as the open recorded it).
 * - That per-row hash is FNV-1a-32: CHANGE DETECTION for the user's own local session file only, between this
 *   process's open and its later reads. It is never an integrity proof on the wire, never sent to a client, and never
 *   a cache key across files; what a client receives is verified by the RULING-57 SHA-256 domains where they apply
 *   (the `fragment` digest of every page) and by the `idFingerprint` it re-derives from the rows.
 */
const READ_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

interface Line extends LineSpan {
	readonly text: string;
}

/** The FrozenBytes of the base, with the bound its row table keeps (RULING-71 (2)). */
export interface BaseBytes extends FrozenBytes {
	readonly rowsPerAnchor: number;
	readonly tableBytes: number;
	/** The most rows one range re-derived; a test instrument for the bounded reparse between anchors. */
	readonly peakRangeRows: number;
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

/** A field of a parsed line, read as the loader's template literal reads `entry.type` / `entry.id`. */
const field = (entry: FileEntry, key: "type" | "id" | "parentId"): unknown =>
	typeof entry === "object" && entry !== null ? Reflect.get(entry, key) : undefined;

function stampedRow(index: number, entry: FileEntry): Buffer {
	const kind = String(field(entry, "type"));
	const parentId = field(entry, "parentId");
	return storedBytes(
		`${JSON.stringify({
			index,
			id: String(field(entry, "id")),
			source: "file",
			parentId: typeof parentId === "string" ? parentId : null,
			kind,
			family: entryFamily(kind),
		})}\n`,
	);
}

class FrozenBaseBytes implements BaseBytes {
	readonly length: number;
	readonly digest: BaseBytes["digest"];
	/** The most lines materialized at once while serving ranges: one, beside the read buffer. */
	peakResidentLeaves = 0;
	peakRangeRows = 0;
	private resident = 0;
	private readonly base: PersistedBase;
	private readonly rows: BaseRowTable;

	constructor(base: PersistedBase, digest: BaseBytes["digest"], rows: BaseRowTable) {
		this.base = base;
		this.digest = digest;
		this.rows = rows;
		this.length = rows.length;
	}

	get rowsPerAnchor(): number {
		return this.rows.rowsPerAnchor;
	}

	get tableBytes(): number {
		return this.rows.tableBytes;
	}

	/** Re-derives every anchor group the range touches, whole, and serves its bytes only once each group verified. */
	async range(offset: number, length: number, valid?: () => void): Promise<Buffer> {
		assertRange(offset, length, this.length);
		const out = Buffer.allocUnsafe(length);
		const end = offset + length;
		const handle = await openIdentified(this.base, this.rows.fileEnd);
		try {
			const walk = this.rows.walk(offset, "verify");
			let rows = 0;
			for await (const line of lines(handle, walk.fileStart, () => valid?.())) {
				const entry = parseSessionEntryLine(line.text);
				if (!entry) continue;
				this.peakResidentLeaves = Math.max(this.peakResidentLeaves, ++this.resident);
				try {
					const from = walk.at;
					const row = stampedRow(walk.row, entry);
					const closed = walk.add(line, row);
					const first = Math.max(offset, from);
					const last = Math.min(end, from + row.length);
					if (last > first) row.copy(out, first - offset, first - from, last - from);
					this.peakRangeRows = Math.max(this.peakRangeRows, ++rows);
					if (closed && walk.at >= end) return out;
				} finally {
					this.resident -= 1;
				}
			}
			throw new CompactReadError("base_file_truncated");
		} finally {
			await handle.close();
		}
	}
}

/**
 * Opens the base's stamped rows after one verifying scan of the file: `count` entries must be there and fingerprint
 * as the cut captured, else a typed `PersistedBaseError` and no source exists. The row table is bounded by `budget`
 * (RULING-71 (2)). The scan belongs to the request that asked for it (RULING-69 (2)): once `signal` aborts no further
 * read happens and the open is `aborted`; `valid` runs after every read of the file.
 */
export async function openBaseBytes(
	base: PersistedBase,
	valid: () => void,
	signal?: AbortSignal,
	budget: number = BASE_ROW_TABLE_BYTES,
): Promise<BaseBytes> {
	const check = () => {
		if (signal?.aborted) throw new CompactReadError("aborted");
		valid();
	};
	const handle = await openIdentified(base);
	try {
		const rows = new BaseRowTable(base.count, budget);
		const walk = rows.walk(0, "record");
		const fingerprint = createHash("sha256");
		const content = new BaseContentHash();
		for await (const line of lines(handle, 0, check)) {
			const entry = parseSessionEntryLine(line.text);
			if (!entry) continue;
			fingerprint.update(fingerprintLine(entry));
			content.line(line.text);
			walk.add(line, stampedRow(walk.row, entry));
			if (walk.row === base.count) break;
		}
		if (walk.row < base.count) throw new CompactReadError("base_file_truncated");
		const digest = parseContentDigest(fingerprint.digest("hex"));
		if (!digest.ok || digest.value !== base.idFingerprint || content.digest() !== base.contentFingerprint)
			throw new CompactReadError("base_fingerprint_mismatch");
		return new FrozenBaseBytes(base, digest.value, rows);
	} finally {
		await handle.close();
	}
}
