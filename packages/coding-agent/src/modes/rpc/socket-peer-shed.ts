import { BaselineBarrier } from "./socket-baseline-barrier.ts";
import { isBarrier, type QueueEntry, type RecoveryEntry, type SocketEventQueue } from "./socket-event-queue.ts";
import type { ResyncCut, ResyncReason } from "./socket-peer-recovery.ts";

/**
 * What a shed does with the records produced while its recovery is pending. `drop` is today's path (the
 * compact-updates flag off): they are dropped and the cut is read when the gap is delivered. `capture` (the
 * flag on) freezes the cut at the shed and delivers the captured suffix after it.
 */
export type ShedMode = "drop" | "capture";

export type ResyncSnapshot = (reason: ResyncReason, carried?: readonly string[]) => ResyncCut;

/** One peer's pending cut: which records it keeps, where a reply goes, and when the cut is read. */
export class SocketPeerShed {
	private pending?: RecoveryEntry;
	private readonly queue: SocketEventQueue;
	private readonly mode: ShedMode;

	constructor(queue: SocketEventQueue, mode: ShedMode) {
		this.queue = queue;
		this.mode = mode;
	}

	get isPending(): boolean {
		return this.pending !== undefined;
	}

	/** True while the pending recovery drops the records it does not capture: today's path, or a capture gone stale. */
	get dropsRecords(): boolean {
		return this.pending !== undefined && (this.mode === "drop" || this.pending.stale);
	}

	/**
	 * Freeze the cut C now: keep the replies, release every record and baseline the cut covers, and queue the
	 * recovery (gap, then C's frames). With `capture`, the records that follow are kept behind it.
	 */
	cut(reason: ResyncReason, snapshot: ResyncSnapshot, live: () => boolean): void {
		this.queue.retain((item) => !isBarrier(item) && item.reply);
		const cut = snapshot(reason);
		this.pending = {
			kind: "recovery",
			reason,
			sessions: cut.sessions,
			barrier: new BaselineBarrier(cut, live),
			stale: false,
		};
		this.queue.push(this.pending);
	}

	/**
	 * The captured suffix overflowed: release it and the cut at C, and read one fresh cut when the gap is
	 * delivered. Until then records are dropped like today's path, one freeze instead of one per overflowing record.
	 */
	supersede(): void {
		if (!this.pending || this.pending.stale) return;
		const recovery = this.pending;
		this.queue.retain((item) => (isBarrier(item) ? item === recovery : item.reply));
		recovery.barrier.cancel();
		recovery.stale = true;
	}

	/** A reply keeps today's place ahead of the gap while records are dropped; a captured one follows the cut. */
	admitReply(entry: QueueEntry): void {
		if (this.pending && this.mode === "drop") this.queue.insertBefore(this.pending, entry);
		else this.queue.push(entry);
	}

	/** The recovery reaches delivery: a stale one reads its fresh cut now, carrying the sessions of the cut it replaces. */
	take(entry: RecoveryEntry, snapshot: ResyncSnapshot | undefined, live: () => boolean): BaselineBarrier {
		if (entry.stale && snapshot) entry.barrier = new BaselineBarrier(snapshot(entry.reason, entry.sessions), live);
		if (this.pending === entry) this.pending = undefined;
		return entry.barrier;
	}

	clear(): void {
		this.pending = undefined;
	}
}
