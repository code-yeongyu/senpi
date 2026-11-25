/**
 * The content-free index of an opened session file (senpi#3968). A load used to keep every entry with its body for the
 * session's lifetime, so an opened session cost the host its file's size in memory. While the file loads, every string
 * of at least `SESSION_PAGE_MIN_CHARS` nested in an entry is replaced by a resident token that names the entry's line
 * (id and byte range) and the string's place in it; materializing the token reads that line back. The entry keeps its
 * shape (type, ids, roles, usage, short text), so every reader of the resident form works unchanged, and memory grows
 * with the entry count, not the content. Top-level fields stay resident: labels and session names are read from the
 * resident form directly.
 *
 * Appends never move an earlier line. Anything that does (a rewrite of the file) is caught on read: the line found at
 * the recorded range must be the same entry, or the file is indexed again once per change and the read retried.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
	LineByteRanges,
	parseSessionEntryLine,
	SESSION_READ_BUFFER_SIZE,
	type SessionEntryPager,
	SessionLineSplitter,
} from "./session-entry-file.ts";
import { decodeJsonStringBytes } from "./session-json-string-bytes.ts";
import type { FileEntry } from "./session-manager.ts";
import { RESIDENT_STRING_PREFIX } from "./session-resident-store.ts";

/** A nested string this long or longer stays on disk and is read back by range when materialized. */
export const SESSION_PAGE_MIN_CHARS = 1024;
/** Marks a token id as a page; resident-store ids are SHA-256 hex and never contain it. */
const PAGE_ID_MARK = "@";

type JsonKey = string | number;

interface PagedLine {
	readonly id: string;
	offset: number;
	length: number;
}

/** Where a paged string's JSON text sits inside its line, so a read decodes those bytes alone (senpi#3968). */
interface Slice {
	readonly start: number;
	readonly length: number;
	/** The line's byte length at load: a line of another length is not the one indexed, and is parsed whole. */
	readonly lineLength: number;
}

interface Page {
	readonly line: PagedLine;
	readonly path: readonly JsonKey[];
	readonly slice: Slice | undefined;
}

/** A walk over one line's text in serialization order: the next paged string is searched from `char` on. */
interface LineCursor {
	readonly text: string;
	readonly bytes: number;
	char: number;
	byte: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Finds `item`'s JSON text in the line after the cursor and returns its byte range, or undefined when it is not found
 * exactly where a value for `key` (an object key) or an array element can start; the page then reads its line whole.
 */
const locate = (cursor: LineCursor, item: string, key: string | undefined): Slice | undefined => {
	const encoded = JSON.stringify(item);
	const at = cursor.text.indexOf(encoded, cursor.char);
	if (at < 0) return undefined;
	const before = cursor.text.slice(0, at);
	const fits = key === undefined ? /[[,]$/.test(before) : before.endsWith(`${JSON.stringify(key)}:`);
	if (!fits) return undefined;
	const start = cursor.byte + Buffer.byteLength(cursor.text.slice(cursor.char, at));
	const length = Buffer.byteLength(encoded);
	cursor.char = at + encoded.length;
	cursor.byte = start + length;
	return { start, length, lineLength: cursor.bytes };
};

export class SessionFilePages implements SessionEntryPager {
	private readonly filePath: string;
	private readonly currentVersion: number;
	private readonly pages: Page[] = [];
	private readonly lines = new Map<string, PagedLine>();
	// Only a current-version header turns paging on: an older file is migrated in memory, so its lines differ.
	private paging = false;
	private lineParses = 0;
	private scratch = Buffer.allocUnsafe(64 * 1024);
	private decoded = Buffer.allocUnsafe(64 * 1024);
	private indexedAt: string | undefined;

	constructor(filePath: string, currentVersion: number) {
		this.filePath = filePath;
		this.currentVersion = currentVersion;
	}

	get count(): number {
		return this.pages.length;
	}

	get wholeLineReads(): number {
		return this.lineParses;
	}

	page(entry: FileEntry, offset: number, length: number, text?: string): FileEntry {
		if (entry.type === "session") {
			this.paging = (entry.version ?? 1) >= this.currentVersion;
			return entry;
		}
		if (!this.paging || !isObject(entry)) return entry;
		const line: PagedLine = { id: entry.id, offset, length };
		const cursor = text === undefined ? undefined : { text, bytes: length, char: 0, byte: 0 };
		let paged = false;
		for (const [key, value] of Object.entries(entry)) {
			if (isObject(value)) paged = this.pageStrings(value, [key], line, cursor) || paged;
		}
		if (paged) this.lines.set(entry.id, line);
		return entry;
	}

	read(id: string): string | undefined {
		if (!id.startsWith(PAGE_ID_MARK)) return undefined;
		const page = this.pages[Number(id.slice(PAGE_ID_MARK.length))];
		if (page === undefined) return undefined;
		const text = this.readPage(page);
		if (text !== undefined || !this.reindex()) return text;
		return this.readPage(page);
	}

	private pageStrings(
		value: Record<string, unknown>,
		path: readonly JsonKey[],
		line: PagedLine,
		cursor: LineCursor | undefined,
	): boolean {
		let paged = false;
		const list = Array.isArray(value);
		for (const [key, item] of Object.entries(value)) {
			const at = list ? Number(key) : key;
			if (typeof item === "string" && item.length >= SESSION_PAGE_MIN_CHARS) {
				const slice = cursor === undefined ? undefined : locate(cursor, item, list ? undefined : key);
				value[key] = `${RESIDENT_STRING_PREFIX}${PAGE_ID_MARK}${this.pages.length}`;
				this.pages.push({ line, path: [...path, at], slice });
				paged = true;
			} else if (isObject(item)) {
				paged = this.pageStrings(item, [...path, at], line, cursor) || paged;
			}
		}
		return paged;
	}

	private readPage(page: Page): string | undefined {
		if (page.slice !== undefined && page.line.length === page.slice.lineLength) {
			const text = this.readSlice(page.line, page.slice);
			if (text !== undefined) return text;
		}
		this.lineParses++;
		const entry = this.readLine(page.line);
		if (entry === undefined || entry.type === "session" || entry.id !== page.line.id) return undefined;
		let value: unknown = entry;
		for (const key of page.path) {
			if (!isObject(value)) return undefined;
			value = value[key];
		}
		return typeof value === "string" ? value : undefined;
	}

	/** The string at `slice` decoded alone: no other part of the line is parsed or kept (senpi#3968). */
	private readSlice(line: PagedLine, slice: Slice): string | undefined {
		let fd: number;
		try {
			fd = openSync(this.filePath, "r");
		} catch {
			return undefined;
		}
		try {
			// One scratch buffer serves every read: a full read of a large session pages in all its bodies, and a fresh
			// buffer per body left the allocator holding their total size outside the JS heap.
			if (this.scratch.length < slice.length)
				this.scratch = Buffer.allocUnsafe(Math.max(slice.length, this.scratch.length * 2));
			const bytes = this.scratch.subarray(0, slice.length);
			if (readSync(fd, bytes, 0, slice.length, line.offset + slice.start) !== slice.length) return undefined;
			if (this.decoded.length < slice.length) this.decoded = Buffer.allocUnsafe(this.scratch.length);
			const direct = decodeJsonStringBytes(bytes, this.decoded);
			if (direct !== undefined) return direct;
			const value: unknown = JSON.parse(bytes.toString("utf8"));
			return typeof value === "string" ? value : undefined;
		} catch {
			return undefined;
		} finally {
			closeSync(fd);
		}
	}

	private readLine(line: PagedLine): FileEntry | undefined {
		let fd: number;
		try {
			fd = openSync(this.filePath, "r");
		} catch {
			return undefined;
		}
		try {
			const bytes = Buffer.allocUnsafe(line.length);
			if (readSync(fd, bytes, 0, line.length, line.offset) !== line.length) return undefined;
			return parseSessionEntryLine(bytes.toString("utf8")) ?? undefined;
		} finally {
			closeSync(fd);
		}
	}

	/**
	 * Records every paged line's range again from the file as it is now. Runs at most once per file change (size and
	 * mtime); an id the file holds more than once can no longer name one line and stops resolving, so its readers fall
	 * back to their own JSONL recovery. Returns whether it re-indexed.
	 */
	private reindex(): boolean {
		let stamp: string;
		try {
			const stat = statSync(this.filePath);
			stamp = `${stat.size}:${stat.mtimeMs}`;
		} catch {
			return false;
		}
		if (stamp === this.indexedAt) return false;
		this.indexedAt = stamp;
		const found = new Map<string, number[]>();
		const note = (line: string, offset: number, length: number) => {
			const entry = parseSessionEntryLine(line);
			if (entry === null || entry.type === "session" || !this.lines.has(entry.id)) return;
			found.set(entry.id, [...(found.get(entry.id) ?? []), offset, length]);
		};
		const fd = openSync(this.filePath, "r");
		try {
			const splitter = new SessionLineSplitter();
			const ranges = new LineByteRanges();
			const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
			for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0;) {
				const chunk = buffer.subarray(0, read);
				const bounds = ranges.push(chunk);
				for (const [index, line] of splitter.push(chunk).entries())
					note(line, bounds[2 * index] ?? 0, bounds[2 * index + 1] ?? 0);
				read = readSync(fd, buffer, 0, buffer.length, null);
			}
			const [offset, length] = ranges.finish();
			note(splitter.finish(), offset, length);
		} finally {
			closeSync(fd);
		}
		for (const [id, line] of this.lines) {
			const range = found.get(id);
			if (range?.length !== 2) {
				this.lines.delete(id);
				line.length = 0;
				continue;
			}
			line.offset = range[0] ?? 0;
			line.length = range[1] ?? 0;
		}
		return true;
	}
}
