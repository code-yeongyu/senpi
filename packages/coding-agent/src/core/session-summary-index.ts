import { stat } from "fs/promises";
import { basename, join } from "path";
import type { SessionSummary } from "./session-summary.ts";
import type { SessionSummaryStore } from "./session-summary-cache.ts";
import {
	appendIndexEntries,
	type IndexEntry,
	type LoadedIndex,
	loadIndexFile,
	rewriteIndexFile,
	SESSION_SUMMARY_INDEX_FILE,
	toIndexEntry,
} from "./session-summary-index-file.ts";
import type { FileStamp } from "./session-summary-lru.ts";

export { SESSION_SUMMARY_INDEX_FILE } from "./session-summary-index-file.ts";

/**
 * Upper bound on live index bytes per sessions directory. It sits well above the
 * in-memory cache's 64 MiB because the index is read once per cold listing, not
 * retained; past it the least recently active sessions are left out and stream
 * like any cache miss.
 */
export const SESSION_SUMMARY_INDEX_MAX_BYTES = 256 * 1024 * 1024;

export type SessionSummaryIndexOptions = {
	readonly maxBytes?: number;
};

type Recorded = {
	readonly file: string;
	readonly stamp: FileStamp;
	readonly summary: SessionSummary;
};

/**
 * What this process last saw in one index file: every entry's stamp, trusted
 * only while the index file keeps the size and mtime recorded with it. A warm
 * process uses it to skip loading the index for a file the index cannot serve
 * (changed since it was indexed, or never indexed, like a non-session file).
 */
type IndexSnapshot = {
	readonly indexStamp: FileStamp;
	readonly entryStamps: ReadonlyMap<string, FileStamp>;
};

const snapshots = new Map<string, IndexSnapshot>();

/** Forget every index snapshot, as a fresh process would start. */
export function forgetSessionSummaryIndexSnapshots(): void {
	snapshots.clear();
}

function stampsMatch(left: FileStamp, right: FileStamp): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function statStamp(path: string): Promise<FileStamp | undefined> {
	try {
		const stats = await stat(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs };
	} catch (error) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}

function recency(entry: IndexEntry): number {
	const headerTime = Date.parse(entry.summary.header.timestamp);
	return entry.summary.lastActivityTime ?? (Number.isNaN(headerTime) ? 0 : headerTime);
}

function selectWithinBudget(entries: readonly IndexEntry[], maxBytes: number): IndexEntry[] {
	const kept: IndexEntry[] = [];
	let bytes = 0;
	for (const entry of [...entries].sort((left, right) => recency(right) - recency(left))) {
		if (entry.lineBytes > maxBytes) continue;
		if (bytes + entry.lineBytes > maxBytes) break;
		kept.push(entry);
		bytes += entry.lineBytes;
	}
	return kept;
}

/**
 * Persistent summaries for one sessions directory, stored as
 * `<dir>/.session-summaries.index` (senpi#2087).
 *
 * It is the second cache level behind the in-memory LRU: a cold process lists an
 * unchanged directory by reading this one file instead of re-streaming every
 * session. The file is loaded lazily on the first in-memory miss it can serve,
 * so a warm process does not read it again for a session that just changed.
 * Nothing here throws or logs: an unreadable, corrupt,
 * or unwritable index only means the listing streams, and its rows are
 * identical either way.
 */
export class SessionSummaryIndex implements SessionSummaryStore {
	private readonly path: string;
	private readonly maxBytes: number;
	private loading: Promise<LoadedIndex> | undefined;
	private snapshot: Promise<IndexSnapshot | undefined> | undefined;
	private readonly recorded: Recorded[] = [];

	constructor(dir: string, options: SessionSummaryIndexOptions = {}) {
		this.path = join(dir, SESSION_SUMMARY_INDEX_FILE);
		this.maxBytes = options.maxBytes ?? SESSION_SUMMARY_INDEX_MAX_BYTES;
	}

	async lookup(filePath: string, stamp: FileStamp): Promise<SessionSummary | undefined> {
		const file = basename(filePath);
		if (!this.loading) {
			this.snapshot ??= this.currentSnapshot();
			const known = await this.snapshot;
			const indexed = known?.entryStamps.get(file);
			if (known && !(indexed && stampsMatch(indexed, stamp))) return undefined;
		}
		this.loading ??= this.load();
		const entry = (await this.loading).entries.get(file);
		return entry && stampsMatch(entry.stamp, stamp) ? entry.summary : undefined;
	}

	record(filePath: string, stamp: FileStamp, summary: SessionSummary): void {
		this.recorded.push({ file: basename(filePath), stamp, summary });
	}

	/**
	 * Bring the index up to date after a listing of `presentFiles`.
	 *
	 * Summaries the index lacks are appended one line each. The file is rewritten
	 * instead (temp file, then rename) when it is unusable, or when its entry
	 * bytes exceed twice the live entries' bytes: superseded lines, torn lines,
	 * removed sessions, and entries over the byte budget all count as dead.
	 */
	async persist(presentFiles: readonly string[]): Promise<void> {
		if (!this.loading) return;
		const loaded = await this.loading;
		const entries = new Map(loaded.entries);
		const added = new Set<IndexEntry>();
		for (const { file, stamp, summary } of this.recorded) {
			const existing = entries.get(file);
			if (existing && stampsMatch(existing.stamp, stamp)) continue;
			const entry = toIndexEntry(file, stamp, summary);
			if (!entry) continue;
			entries.set(file, entry);
			added.add(entry);
		}

		const present = new Set(presentFiles.map((path) => basename(path)));
		const live = [...entries.values()].filter((entry) => present.has(entry.file));
		const kept = selectWithinBudget(live, this.maxBytes);
		const keptBytes = kept.reduce((total, entry) => total + entry.lineBytes, 0);
		const appended = kept.filter((entry) => added.has(entry));
		const appendedBytes = appended.reduce((total, entry) => total + entry.lineBytes, 0);

		try {
			if (
				(!loaded.usable && kept.length > 0) ||
				(loaded.usable && loaded.entryBytes + appendedBytes > 2 * keptBytes)
			) {
				await rewriteIndexFile(this.path, kept);
				this.remember(await statStamp(this.path), kept);
			} else if (loaded.usable && appended.length > 0) {
				await appendIndexEntries(this.path, appended, loaded.endsWithNewline);
				const inFile = new Map(loaded.entries);
				for (const entry of appended) inFile.set(entry.file, entry);
				this.remember(await statStamp(this.path), inFile.values());
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			snapshots.delete(this.path);
		}
	}

	private async currentSnapshot(): Promise<IndexSnapshot | undefined> {
		const recorded = snapshots.get(this.path);
		if (!recorded) return undefined;
		const current = await statStamp(this.path);
		return current && stampsMatch(current, recorded.indexStamp) ? recorded : undefined;
	}

	/** Stat before reading, so a concurrent writer can only make the snapshot look stale. */
	private async load(): Promise<LoadedIndex> {
		const before = await statStamp(this.path);
		const loaded = await loadIndexFile(this.path);
		this.remember(before, loaded.usable ? loaded.entries.values() : undefined);
		return loaded;
	}

	private remember(indexStamp: FileStamp | undefined, entries: Iterable<IndexEntry> | undefined): void {
		if (!indexStamp || !entries) {
			snapshots.delete(this.path);
			return;
		}
		const entryStamps = new Map<string, FileStamp>();
		for (const entry of entries) entryStamps.set(entry.file, entry.stamp);
		snapshots.set(this.path, { indexStamp, entryStamps });
	}
}
