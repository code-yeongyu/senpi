import type { BaselineBarrier } from "./socket-baseline-barrier.ts";
import type { ResyncReason } from "./socket-peer-recovery.ts";

export type QueueEntry = {
	line: string;
	bytes: number;
	key?: string;
	/**
	 * The record with its cumulative snapshot fields blanked (delta kept). When a
	 * later record with the same key supersedes this one, the entry is rewritten to
	 * this line instead of being replaced, so a stalled reader never loses a delta.
	 */
	demotedLine?: string;
	onWritten?: () => void;
	reply: boolean;
	/** Set on a record captured behind a pending cut: it reaches the peer only while the peer still holds its session. */
	held?: () => boolean;
	/** A targeted reply's destination check, repeated immediately before its write (#4728). */
	current?: () => boolean;
};

/** A late peer's attach baseline in its FIFO position. */
export type AttachEntry = { readonly kind: "attach"; readonly barrier: BaselineBarrier };

/** A shed's recovery in its FIFO position: the gap, then the cut's frames. A stale one reads a fresh cut when delivered. */
export type RecoveryEntry = {
	readonly kind: "recovery";
	readonly reason: ResyncReason;
	readonly sessions: readonly string[];
	barrier: BaselineBarrier;
	stale: boolean;
};

export type QueueItem = QueueEntry | AttachEntry | RecoveryEntry;

export const isBarrier = (item: QueueItem): item is AttachEntry | RecoveryEntry => "kind" in item;

/** One socket's FIFO: records charged by their bytes, barriers weighing nothing. */
export class SocketEventQueue {
	private items: QueueItem[] = [];
	private charged = 0;

	get bytes(): number {
		return this.charged;
	}

	get length(): number {
		return this.items.length;
	}

	push(item: QueueItem): void {
		this.items.push(item);
		if (!isBarrier(item)) this.charged += item.bytes;
	}

	shift(): QueueItem | undefined {
		const item = this.items.shift();
		if (item !== undefined && !isBarrier(item)) this.charged -= item.bytes;
		return item;
	}

	/** A record takes its place ahead of `before` while that is still queued, else the tail. */
	insertBefore(before: QueueItem, entry: QueueEntry): void {
		const at = this.items.indexOf(before);
		if (at < 0) this.items.push(entry);
		else this.items.splice(at, 0, entry);
		this.charged += entry.bytes;
	}

	/**
	 * Lossless supersession of the queued record with `key`. The old behaviour replaced the queued line
	 * outright, which threw away every delta a stalled reader had not yet received (a desktop client
	 * assembles text from deltas). Keep the superseded record - demoted to its delta-only form when the
	 * producer supplied one - and let only the newest record carry the snapshot.
	 */
	supersede(key: string): void {
		const existing = this.items.find((item) => !isBarrier(item) && item.key === key);
		if (existing === undefined || isBarrier(existing)) return;
		if (existing.demotedLine !== undefined) {
			this.charged -= existing.bytes;
			existing.line = existing.demotedLine;
			existing.bytes = Buffer.byteLength(existing.line);
			this.charged += existing.bytes;
			existing.demotedLine = undefined;
		}
		existing.key = undefined;
	}

	/** Keeps the items `keep` accepts; every other record is released (`onWritten`) and every other barrier ended. */
	retain(keep: (item: QueueItem) => boolean): void {
		const kept: QueueItem[] = [];
		for (const item of this.items) {
			if (keep(item)) kept.push(item);
			else if (isBarrier(item)) item.barrier.cancel();
			else item.onWritten?.();
		}
		this.items = kept;
		this.charged = kept.reduce((bytes, item) => (isBarrier(item) ? bytes : bytes + item.bytes), 0);
	}

	/** Ends every barrier and empties the queue; the dropped records' callbacks never run. */
	clear(): void {
		for (const item of this.items) if (isBarrier(item)) item.barrier.cancel();
		this.items.length = 0;
		this.charged = 0;
	}
}
