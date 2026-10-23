import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import type { EventLoopSlicer } from "../event-loop-slicer.ts";
import { parseSessionEntryLine, SESSION_READ_BUFFER_SIZE } from "../session-entry-file.ts";
import type { FileEntry } from "../session-manager.ts";
import { ByteLineSplitter } from "./byte-lines.ts";
import { readIndexedLine, statSessionFile } from "./index-file.ts";
import { type IndexedEntry, indexRecordOf } from "./index-record.ts";
import { readSidecar, type SavedIndex, writeSidecar } from "./sidecar.ts";

export interface IndexScan {
	readonly reusedRecords: number;
	readonly scannedBytes: number;
	readonly rebuilt: boolean;
	readonly saveError?: string;
}

/** The line a record points at no longer holds that entry: the file was replaced or rewritten under the index. */
export class StaleIndexError extends Error {
	constructor(record: IndexedEntry) {
		super(`session index is stale: no ${record.type} entry ${record.id} at byte ${record.offset}`);
		this.name = "StaleIndexError";
	}
}

interface Identity {
	readonly dev: number;
	readonly ino: number;
}

/**
 * A content-free index of a session JSONL file (senpi#3968): one `IndexedEntry` per parsed line, in file order, with
 * its exact UTF-8 byte range. The JSONL stays the authority; the index is derived from it and saved beside it so a
 * reopen parses only the lines appended since (`sidecar.ts`).
 *
 * Invariants: only complete (newline-terminated) lines are saved, so a crash can never make an uncommitted line
 * visible through the saved index; a final line without a newline is indexed in memory when it parses, exactly as the
 * loader keeps it, and is read again on the next refresh. A different file (inode), a file shorter than the saved
 * boundary, or a saved record that no longer matches its line discards the saved index and rebuilds it. Malformed
 * lines are skipped and duplicate ids are kept in order, as `loadEntriesFromFile` does.
 */
export class SessionByteIndex {
	private committed: IndexedEntry[] = [];
	private pending: IndexedEntry | undefined;
	private committedBytes = 0;
	private identity: Identity | undefined;
	private accepted = true;
	private scan: IndexScan = { reusedRecords: 0, scannedBytes: 0, rebuilt: true };

	readonly sessionFile: string;
	private readonly persist: boolean;

	private constructor(sessionFile: string, persist: boolean) {
		this.sessionFile = sessionFile;
		this.persist = persist;
	}

	static open(sessionFile: string, options: { readonly persist?: boolean } = {}): SessionByteIndex {
		const index = new SessionByteIndex(sessionFile, options.persist ?? true);
		const saved = readSidecar(sessionFile);
		if (saved !== undefined && index.adopt(saved)) index.update(saved.records.length, false);
		else index.rebuild();
		return index;
	}

	/** `open` for a host that shares its event loop: the file is parsed in slices that yield (senpi#3518). */
	static async openAsync(
		sessionFile: string,
		slicer: EventLoopSlicer,
		options: { readonly persist?: boolean } = {},
	): Promise<SessionByteIndex> {
		const index = new SessionByteIndex(sessionFile, options.persist ?? true);
		const saved = readSidecar(sessionFile);
		const reused = saved !== undefined && index.adopt(saved);
		if (!reused) index.reset();
		await index.updateAsync(reused ? saved.records.length : 0, !reused, slicer);
		return index;
	}

	/** Every indexed entry, header first; empty when the file is not a session (its first entry is no header). */
	get records(): readonly IndexedEntry[] {
		if (!this.accepted) return [];
		return this.pending === undefined ? this.committed : [...this.committed, this.pending];
	}

	get committedLength(): number {
		return this.committedBytes;
	}

	get lastScan(): IndexScan {
		return this.scan;
	}

	/** Brings the index up to date with the file: only bytes past the committed boundary are read. */
	refresh(): IndexScan {
		const current = statSessionFile(this.sessionFile);
		const sameFile =
			current !== undefined &&
			this.identity !== undefined &&
			current.dev === this.identity.dev &&
			current.ino === this.identity.ino &&
			current.size >= this.committedBytes &&
			this.matchesFile(this.committed.at(-1));
		if (sameFile) this.update(this.committed.length, false);
		else this.rebuild();
		return this.scan;
	}

	/** Reads the entry `record` points at from the file, checking that the line still holds that entry. */
	readEntry(record: IndexedEntry): FileEntry {
		const entry = readIndexedLine(this.sessionFile, record, false);
		if (entry === undefined) throw new StaleIndexError(record);
		return entry;
	}

	private adopt(saved: SavedIndex): boolean {
		const current = statSessionFile(this.sessionFile);
		if (current === undefined || current.dev !== saved.dev || current.ino !== saved.ino) return false;
		if (current.size < saved.committedBytes || saved.records.length === 0) return false;
		const [header] = saved.records;
		if (header?.type !== "session" || !this.matchesFile(header) || !this.matchesFile(saved.records.at(-1))) {
			return false;
		}
		this.committed = [...saved.records];
		this.committedBytes = saved.committedBytes;
		this.identity = { dev: saved.dev, ino: saved.ino };
		return true;
	}

	private reset(): void {
		this.committed = [];
		this.committedBytes = 0;
		this.accepted = true;
	}

	private rebuild(): void {
		this.reset();
		this.update(0, true);
	}

	private update(reusedRecords: number, rebuilt: boolean): void {
		this.pending = undefined;
		const before = this.committedBytes;
		this.settle(reusedRecords, rebuilt, this.readFrom(before) - before);
	}

	private async updateAsync(reusedRecords: number, rebuilt: boolean, slicer: EventLoopSlicer): Promise<void> {
		this.pending = undefined;
		const before = this.committedBytes;
		this.settle(reusedRecords, rebuilt, (await this.readFromAsync(before, slicer)) - before);
	}

	private settle(reusedRecords: number, rebuilt: boolean, scannedBytes: number): void {
		const saveError = scannedBytes > 0 || rebuilt ? this.save() : undefined;
		this.scan = { reusedRecords, scannedBytes, rebuilt, ...(saveError === undefined ? {} : { saveError }) };
	}

	private async readFromAsync(start: number, slicer: EventLoopSlicer): Promise<number> {
		if (!existsSync(this.sessionFile)) {
			this.identity = undefined;
			return start;
		}
		const handle = await open(this.sessionFile, "r");
		try {
			const stat = await handle.stat();
			this.identity = { dev: stat.dev, ino: stat.ino };
			const splitter = new ByteLineSplitter(start);
			const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
			let position = start;
			while (this.accepted) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				if (bytesRead === 0) break;
				position += bytesRead;
				for (const line of splitter.push(buffer.subarray(0, bytesRead))) {
					this.indexLine(line.offset, line.bytes, true);
					if (slicer.due) await slicer.yield();
				}
			}
			this.finishRead(splitter);
			return position;
		} finally {
			await handle.close();
		}
	}

	private readFrom(start: number): number {
		if (!existsSync(this.sessionFile)) {
			this.identity = undefined;
			return start;
		}
		const fd = openSync(this.sessionFile, "r");
		try {
			const stat = fstatSync(fd);
			this.identity = { dev: stat.dev, ino: stat.ino };
			const splitter = new ByteLineSplitter(start);
			const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
			let position = start;
			while (this.accepted) {
				const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
				if (bytesRead === 0) break;
				position += bytesRead;
				for (const line of splitter.push(buffer.subarray(0, bytesRead)))
					this.indexLine(line.offset, line.bytes, true);
			}
			this.finishRead(splitter);
			return position;
		} finally {
			closeSync(fd);
		}
	}

	private finishRead(splitter: ByteLineSplitter): void {
		const tail = splitter.finish();
		if (tail !== undefined) this.indexLine(tail.offset, tail.bytes, false);
		this.committedBytes = splitter.committedEnd;
	}

	private indexLine(offset: number, bytes: Buffer, complete: boolean): void {
		if (!this.accepted) return;
		const entry = parseSessionEntryLine(bytes.toString("utf8"));
		if (entry === null) return;
		if (this.committed.length === 0 && (entry.type !== "session" || typeof entry.id !== "string")) {
			this.accepted = false;
			return;
		}
		const record = indexRecordOf(entry, offset, bytes);
		if (complete) this.committed.push(record);
		else this.pending = record;
	}

	private save(): string | undefined {
		if (!this.persist || !this.accepted || this.identity === undefined || this.committed.length === 0)
			return undefined;
		const saved = { ...this.identity, committedBytes: this.committedBytes, records: this.committed };
		return writeSidecar(this.sessionFile, saved)?.message;
	}

	private matchesFile(record: IndexedEntry | undefined): boolean {
		return record === undefined || readIndexedLine(this.sessionFile, record, true) !== undefined;
	}
}
