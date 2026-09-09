import { stat } from "fs/promises";
import { resolve } from "path";
import { readSessionSummary, type SessionSummary } from "./session-summary.ts";
import { type FileStamp, SessionSummaryLru } from "./session-summary-lru.ts";

/**
 * Upper bound on cached session files, evicted least-recently-used rather than
 * grown with the sessions directory.
 */
export const SESSION_SUMMARY_CACHE_LIMIT = 4096;

/**
 * Upper bound on retained transcript text across the whole cache.
 *
 * A cached summary's footprint is its `allMessagesText`, which grows with the
 * session, so the entry ceiling alone bounds nothing: 4096 large sessions would
 * pin gigabytes for the life of the process. 64 MiB is deliberately conservative
 * — it holds a normal user's entire sessions directory (a heavy 2 MB session
 * file yields well under 2 MB of visible text, so hundreds of them fit) while
 * capping the worst case at a fraction of a Node heap. Exceeding it evicts the
 * least recently listed sessions, which then cost one streaming re-read.
 */
export const SESSION_SUMMARY_CACHE_MAX_TEXT_BYTES = 64 * 1024 * 1024;

export type CachedSessionSummary = {
	readonly summary: SessionSummary;
	readonly mtime: Date;
};

/** Process-local summary cache, bounded by entry count and retained text bytes. */
const cache = new SessionSummaryLru({
	maxEntries: SESSION_SUMMARY_CACHE_LIMIT,
	maxTextBytes: SESSION_SUMMARY_CACHE_MAX_TEXT_BYTES,
});

function stampsMatch(left: FileStamp, right: FileStamp): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/**
 * Exact summary of one session file, reusing the cached summary when the file's
 * size and mtime are unchanged since it was read.
 *
 * A cache hit deserializes nothing: the whole point is that listing an unchanged
 * sessions directory costs one `stat` per file. A file that cannot be stat'ed or
 * read drops its cache entry, so a truncated or replaced file is never served
 * from stale bytes. A summary too large for the cache's byte budget is returned
 * to the caller without being retained.
 */
export async function readCachedSessionSummary(filePath: string): Promise<CachedSessionSummary | null> {
	const key = resolve(filePath);

	let stamp: FileStamp;
	let mtime: Date;
	try {
		const stats = await stat(filePath);
		stamp = { size: stats.size, mtimeMs: stats.mtimeMs };
		mtime = stats.mtime;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		cache.drop(key);
		return null;
	}

	const cached = cache.get(key);
	if (cached && stampsMatch(cached.stamp, stamp)) {
		return { summary: cached.summary, mtime: cached.mtime };
	}

	const summary = await readSessionSummary(filePath);
	if (!summary) {
		cache.drop(key);
		return null;
	}

	cache.retain(key, { stamp, summary, mtime });
	return { summary, mtime };
}

/** Drop every cached summary. Test-only seam for cold-read assertions. */
export function clearSessionSummaryCache(): void {
	cache.clear();
}

/** Number of cached summaries. Test-only seam for eviction assertions. */
export function sessionSummaryCacheSize(): number {
	return cache.size;
}

/** Retained transcript bytes across the cache. Test-only seam for budget assertions. */
export function sessionSummaryCacheTextBytes(): number {
	return cache.textBytes;
}
