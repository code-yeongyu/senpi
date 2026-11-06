import type { LeafId } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { CompactSpoolStorage } from "./compact-spool-storage.ts";
import type { CompactStorageOperation } from "./compact-storage-io.ts";

/** Where a committed leaf's bytes are; a rewrite moves the slot while the leaf stays committed. */
export interface CompactSlot {
	segment: CompactSegment;
	offset: number;
	readonly bytes: number;
}

/** Byte bound of every segment file, value batches and compaction-round node sets alike (RULING-54). */
export const COMPACT_SEGMENT_BYTES = 65_536;

/** Where one text of a flush batch landed: its segment file and its offset in it. */
export type CompactPlacement = readonly [segment: CompactSegment, offset: number];

/** One flush batch in one spool file, with the leaves still live in it. */
export interface CompactSegment {
	readonly path: string;
	readonly bytes: number;
	readonly operation: CompactStorageOperation;
	readonly live: Map<LeafId, CompactSlot>;
	liveBytes: number;
	readers: number;
	rewritten: boolean;
}

/**
 * Segment packing of compact current-state storage (senpi#4272, RULING-47): a flush batch is a run of
 * spool files of at most `COMPACT_SEGMENT_BYTES` each (RULING-54), and each leaf is read back by offset
 * from the one file holding it. A segment is deleted once its last live leaf is
 * released and no read of it is in flight. When its live bytes fall below half its size it is
 * rewritten once, so dead bytes on disk stay at most the live bytes of the segments holding them;
 * a failed rewrite halts spilling and keeps the old segment readable.
 */
export abstract class CompactSegmentStorage extends CompactSpoolStorage {
	/** Writes the texts back to back as one new file; undefined when the write failed and was reported. */
	protected async writeSegment(
		texts: readonly string[],
		operation: CompactStorageOperation,
	): Promise<CompactSegment | undefined> {
		const data = Buffer.from(texts.join(""), "utf16le");
		const path = await this.writeFile(data, operation, data.byteLength);
		if (path === undefined) return undefined;
		return { path, bytes: data.byteLength, operation, live: new Map(), liveBytes: 0, readers: 0, rewritten: false };
	}

	/** Splits sized entries, in order, into runs of at most `COMPACT_SEGMENT_BYTES`; a larger entry runs alone. */
	protected segmentRuns<T>(entries: Iterable<readonly [T, number]>): T[][] {
		const runs: T[][] = [];
		let bytes = 0;
		for (const [entry, size] of entries) {
			const run = runs.at(-1);
			if (run && bytes + size <= COMPACT_SEGMENT_BYTES) {
				run.push(entry);
				bytes += size;
			} else {
				runs.push([entry]);
				bytes = size;
			}
		}
		return runs;
	}

	/**
	 * Writes the texts as one run of bounded segment files, in order, and returns each text's placement
	 * once EVERY file is durable; nothing is registered before then. A failed write discards the files
	 * the run already wrote and returns undefined, so a batch becomes visible as a whole or not at all.
	 */
	protected async writeSegments(
		texts: readonly string[],
		operation: CompactStorageOperation,
	): Promise<readonly CompactPlacement[] | undefined> {
		const placements: CompactPlacement[] = [];
		const written: CompactSegment[] = [];
		let complete = false;
		try {
			for (const run of this.segmentRuns(texts.map((text, n) => [n, text.length * 2] as const))) {
				const segment = await this.writeSegment(
					run.map((n) => texts[n]),
					operation,
				);
				if (!segment) return undefined;
				written.push(segment);
				let offset = 0;
				for (const n of run) {
					placements[n] = [segment, offset];
					offset += texts[n].length * 2;
				}
			}
			complete = true;
			return placements;
		} finally {
			// A write that failed or threw leaves the files before it unreferenced: reclaim them now.
			if (!complete) for (const stray of written) this.discard(stray.path, stray.bytes);
		}
	}

	protected place(segment: CompactSegment, id: LeafId, offset: number, bytes: number): CompactSlot {
		const slot = { segment, offset, bytes };
		segment.live.set(id, slot);
		segment.liveBytes += bytes;
		return slot;
	}

	protected leave(id: LeafId, slot: CompactSlot): void {
		const segment = slot.segment;
		segment.live.delete(id);
		segment.liveBytes -= slot.bytes;
		this.settle(segment);
	}

	protected async readSlot(slot: CompactSlot): Promise<Buffer> {
		const { segment, offset, bytes } = slot;
		segment.readers++;
		try {
			return await this.readFile(segment.path, bytes, "leaf_read", { offset, length: bytes });
		} finally {
			segment.readers--;
			this.settle(segment);
		}
	}

	/** Deletes an empty segment no read holds, or queues the one rewrite of a mostly dead segment. */
	protected settle(segment: CompactSegment): void {
		if (!segment.live.size) {
			if (!segment.readers) this.discard(segment.path, segment.bytes);
		} else if (!segment.rewritten && segment.liveBytes * 2 < segment.bytes) {
			segment.rewritten = true;
			this.enqueue("reclaim", () => this.rewrite(segment));
		}
	}

	/**
	 * Copies the live leaves into a new segment, then repoints their slots; the old file goes when unread.
	 * Only live bytes are read (one range per adjacent run) and they count as I/O copy bytes until the end.
	 */
	private async rewrite(segment: CompactSegment): Promise<void> {
		if (!this.spillAllowed || !segment.live.size) return;
		segment.readers++;
		let next: CompactSegment | undefined;
		let copied = 0;
		try {
			const moving = [...segment.live].sort(([, a], [, b]) => a.offset - b.offset);
			const texts: string[] = [];
			for (let n = 0; n < moving.length;) {
				const start = moving[n][1].offset;
				let end = start;
				const run: CompactSlot[] = [];
				for (; n < moving.length && moving[n][1].offset === end; n++) {
					run.push(moving[n][1]);
					end += moving[n][1].bytes;
				}
				const data = await this.readFile(segment.path, end - start, "leaf_read", {
					offset: start,
					length: end - start,
				});
				this.pendingIoCopyBytes += data.byteLength;
				copied += data.byteLength;
				for (const slot of run)
					texts.push(data.toString("utf16le", slot.offset - start, slot.offset - start + slot.bytes));
			}
			next = await this.writeSegment(texts, segment.operation);
			let offset = 0;
			for (const [id, slot] of moving) {
				// A leaf released while the copy was written stays out of the new segment's live set.
				if (next && segment.live.delete(id)) {
					segment.liveBytes -= slot.bytes;
					next.live.set(id, slot);
					next.liveBytes += slot.bytes;
					slot.segment = next;
					slot.offset = offset;
				}
				offset += slot.bytes;
			}
		} catch (error) {
			// Retirement during the copy is an orderly abort: the epoch directory goes with the store.
			if (!(error instanceof CompactReadError && error.reason === "retired")) throw error;
		} finally {
			this.pendingIoCopyBytes -= copied;
			segment.readers--;
			this.settle(segment);
			if (next) this.settle(next);
		}
	}
}
