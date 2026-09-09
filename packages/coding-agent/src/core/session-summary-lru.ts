import type { SessionSummary } from "./session-summary.ts";

/** Identity of the exact bytes a cached summary was derived from. */
export type FileStamp = {
	readonly size: number;
	readonly mtimeMs: number;
};

/** One cached session summary plus the file identity it was derived from. */
export type SummaryEntry = {
	readonly stamp: FileStamp;
	readonly summary: SessionSummary;
	/** The file's mtime at read time, used for the row's fallback modified date. */
	readonly mtime: Date;
};

/** Both ceilings a retained set of summaries has to stay under. */
export type SummaryCacheBudget = {
	readonly maxEntries: number;
	readonly maxTextBytes: number;
};

type RetainedEntry = {
	readonly entry: SummaryEntry;
	readonly textBytes: number;
};

/**
 * Least-recently-used store of session summaries bounded by BOTH entry count and
 * retained transcript bytes.
 *
 * An entry ceiling alone does not bound memory: a summary's footprint is
 * dominated by `allMessagesText`, which grows with the transcript, so the same
 * 4096 entries can hold kilobytes or gigabytes depending on whose sessions they
 * are. `Map` preserves insertion order, so re-inserting on every hit makes the
 * first key the least recently used one.
 */
export class SessionSummaryLru {
	private readonly entries = new Map<string, RetainedEntry>();
	private readonly budget: SummaryCacheBudget;
	private retainedTextBytes = 0;

	constructor(budget: SummaryCacheBudget) {
		this.budget = budget;
	}

	get size(): number {
		return this.entries.size;
	}

	/** Retained transcript bytes across every cached summary. */
	get textBytes(): number {
		return this.retainedTextBytes;
	}

	/** The cached entry for this key, promoted to most-recently-used. */
	get(key: string): SummaryEntry | undefined {
		const retained = this.entries.get(key);
		if (!retained) return undefined;
		this.entries.delete(key);
		this.entries.set(key, retained);
		return retained.entry;
	}

	drop(key: string): void {
		const retained = this.entries.get(key);
		if (!retained) return;
		this.entries.delete(key);
		this.retainedTextBytes -= retained.textBytes;
	}

	/**
	 * Retain one summary, evicting least-recently-used entries until both ceilings
	 * hold.
	 *
	 * A summary whose own transcript exceeds the byte budget is never retained:
	 * caching it could only be paid for by evicting every other entry, and it
	 * would still have to be evicted on the next insert. The caller keeps the
	 * summary it asked for either way. Any previous entry under this key is
	 * dropped first, so an oversized re-read can never leave stale bytes behind.
	 */
	retain(key: string, entry: SummaryEntry): void {
		this.drop(key);
		const textBytes = Buffer.byteLength(entry.summary.allMessagesText, "utf8");
		if (textBytes > this.budget.maxTextBytes) return;
		this.entries.set(key, { entry, textBytes });
		this.retainedTextBytes += textBytes;
		this.evictUntilWithinBudget();
	}

	clear(): void {
		this.entries.clear();
		this.retainedTextBytes = 0;
	}

	private evictUntilWithinBudget(): void {
		while (this.entries.size > this.budget.maxEntries || this.retainedTextBytes > this.budget.maxTextBytes) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.drop(oldest.value);
		}
	}
}
