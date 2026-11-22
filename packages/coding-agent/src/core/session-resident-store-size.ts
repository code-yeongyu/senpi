import { Buffer } from "buffer";

/** What a resident store holds in memory right now: entry count and summed UTF-8 length. */
export interface ResidentStoreSize {
	readonly entries: number;
	readonly approxBytes: number;
}

/** Incremental byte accounting of a resident string store: updated per string, never by re-serializing. */
export class ResidentSizeAccounting {
	private bytes = 0;
	private evictedCount = 0;
	private evictedBytes = 0;

	get residentBytes(): number {
		return this.bytes;
	}

	added(text: string): void {
		this.bytes += Buffer.byteLength(text, "utf8");
	}

	removed(text: string): void {
		this.bytes -= Buffer.byteLength(text, "utf8");
	}

	/** A string left memory for its blob file. */
	evicted(text: string): void {
		this.evictedCount++;
		this.evictedBytes += Buffer.byteLength(text, "utf8");
	}

	reset(): void {
		this.bytes = 0;
		this.evictedCount = 0;
		this.evictedBytes = 0;
	}

	stats(): { blobBytes: number; evictedCount: number; evictedBytes: number } {
		return { blobBytes: this.bytes, evictedCount: this.evictedCount, evictedBytes: this.evictedBytes };
	}
}
