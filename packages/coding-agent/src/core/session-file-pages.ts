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

interface Page {
	readonly line: PagedLine;
	readonly path: readonly JsonKey[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export class SessionFilePages implements SessionEntryPager {
	private readonly filePath: string;
	private readonly currentVersion: number;
	private readonly pages: Page[] = [];
	private readonly lines = new Map<string, PagedLine>();
	// Only a current-version header turns paging on: an older file is migrated in memory, so its lines differ.
	private paging = false;
	private indexedAt: string | undefined;

	constructor(filePath: string, currentVersion: number) {
		this.filePath = filePath;
		this.currentVersion = currentVersion;
	}

	page(entry: FileEntry, offset: number, length: number): FileEntry {
		if (entry.type === "session") {
			this.paging = (entry.version ?? 1) >= this.currentVersion;
			return entry;
		}
		if (!this.paging || !isObject(entry)) return entry;
		const line: PagedLine = { id: entry.id, offset, length };
		let paged = false;
		for (const [key, value] of Object.entries(entry)) {
			if (isObject(value)) paged = this.pageStrings(value, [key], line) || paged;
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

	private pageStrings(value: Record<string, unknown>, path: readonly JsonKey[], line: PagedLine): boolean {
		let paged = false;
		const list = Array.isArray(value);
		for (const [key, item] of Object.entries(value)) {
			const at = list ? Number(key) : key;
			if (typeof item === "string" && item.length >= SESSION_PAGE_MIN_CHARS) {
				value[key] = `${RESIDENT_STRING_PREFIX}${PAGE_ID_MARK}${this.pages.length}`;
				this.pages.push({ line, path: [...path, at] });
				paged = true;
			} else if (isObject(item)) {
				paged = this.pageStrings(item, [...path, at], line) || paged;
			}
		}
		return paged;
	}

	private readPage(page: Page): string | undefined {
		const entry = this.readLine(page.line);
		if (entry === undefined || entry.type === "session" || entry.id !== page.line.id) return undefined;
		let value: unknown = entry;
		for (const key of page.path) {
			if (!isObject(value)) return undefined;
			value = value[key];
		}
		return typeof value === "string" ? value : undefined;
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
