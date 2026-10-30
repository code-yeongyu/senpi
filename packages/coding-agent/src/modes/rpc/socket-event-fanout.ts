import type { LegacyViewCursor } from "./legacy-view-cursor.ts";
import { BaselineBarrier } from "./socket-baseline-barrier.ts";
import { type DrainStallPeer, waitForDrainOrStall } from "./socket-drain-stall.ts";
import { SocketEventQueueOverflowError } from "./socket-event-queue-errors.ts";
import {
	type AttachEntry,
	isBarrier,
	type QueueEntry,
	type RecoveryEntry,
	SocketEventQueue,
} from "./socket-event-queue.ts";
import { type ResyncReason, SocketPeerRecovery } from "./socket-peer-recovery.ts";
import { type ResyncSnapshot, type ShedMode, SocketPeerShed } from "./socket-peer-shed.ts";

export { SocketEventQueueOverflowError, SocketEventQueueStallError } from "./socket-event-queue-errors.ts";
export type { ResyncSnapshot, ShedMode } from "./socket-peer-shed.ts";

type SocketSink = {
	writeRaw(chunk: string): void;
	waitForBackpressure(): Promise<void>;
};

// A handful of image tool results is several MiB of base64 each; four of them
// blew the previous 4 MiB cap in one burst on a healthy reader. Overflow is a
// fail-closed disconnect (the client must resync), so the cap has to be well
// above any single burst a normal session produces.
const DEFAULT_QUEUE_BYTES = 64 * 1024 * 1024;

// Backpressure budget, NOT a credit pacer. A session worker's output credit is
// returned when every destination has ACCEPTED the record into its bounded queue
// (session-event-writer.ts, waitForSessionBackpressure), so a peer's kernel drain
// is no longer on the worker's critical path and this budget is deliberately
// independent of SESSION_WORKER_LIMITS.controlMs (5 s). It used to be forced below
// that deadline, which made a client busy for 4 s with >= 16 KB pending (macOS unix
// stream buffers are 8 KB each way) indistinguishable from a dead one: it was cut
// and its sessions were released (#1774). Tens of seconds of no progress at all is
// the legacy client's liveness signal. A client advertising event_resync instead
// sheds its buffered events at this deadline and is cut only after a missed ping.
//
// The budget is loop-SERVED time. While the host's own loop is blocked nobody can
// drain anything, and on unblock the timers phase runs before the pending drain I/O,
// so a wall-clock deadline cut every live peer after a long host stall (#1905). The
// deadline therefore re-arms for whatever blocked time the loop-lag watchdog recorded
// inside its window, and only a window the loop fully served ends in a cut.
export const DEFAULT_STALL_MS = 30_000;

/** Independent FIFO actor for one socket. It never shares a drain promise with another sink. */
export class SocketEventSinkActor {
	private readonly queue = new SocketEventQueue();
	private draining?: Promise<void>;
	private closed = false;
	private failure?: unknown;
	private recovery?: SocketPeerRecovery;
	private recoveryEnabled = false;
	private snapshot?: ResyncSnapshot;
	private readonly shed: SocketPeerShed;
	private attempt?: BaselineBarrier;
	/** The attach frame in flight, charged against the budget until the sink accepted it. */
	private frameBytes = 0;
	private readonly stopped = new AbortController();

	private readonly sink: SocketSink;
	private readonly onFailure: (cause: unknown) => void;
	private readonly maxQueueBytes: number;
	private readonly stallPeer: DrainStallPeer;

	constructor(
		sink: SocketSink,
		onFailure: (cause: unknown) => void,
		maxQueueBytes = DEFAULT_QUEUE_BYTES,
		stallMs = DEFAULT_STALL_MS,
		shedMode: ShedMode = "drop",
	) {
		this.sink = sink;
		this.onFailure = onFailure;
		this.maxQueueBytes = maxQueueBytes;
		this.shed = new SocketPeerShed(this.queue, shedMode);
		this.stallPeer = {
			sink,
			stallMs,
			stopped: this.stopped.signal,
			queuedBytes: () => this.queue.bytes,
			shedAndPing: () => {
				if (!this.recovery || !this.recoveryEnabled) return false;
				this.cutOnce("stall");
				this.recovery.ping();
				return true;
			},
		};
	}

	enableRecovery(snapshot: ResyncSnapshot): void {
		this.recoveryEnabled = true;
		this.snapshot = snapshot;
		this.recovery ??= new SocketPeerRecovery((line) => this.sink.writeRaw(line));
		this.recovery.acknowledge();
	}

	disableRecovery(): void {
		this.recoveryEnabled = false;
		if (!this.recovery?.pending) this.recovery = undefined;
	}

	/**
	 * A newly attached session's baseline, frozen by the caller: it takes this FIFO position, so every record
	 * enqueued after it follows it, and a stale attempt (`live` false) writes nothing. Never holds credit. A view
	 * with no frame installs nothing, so the next record goes in flight exactly as before the attach; while a
	 * recovery drops records the view is dropped too, covered by the cut read at the delivery.
	 */
	installBaseline(cursor: LegacyViewCursor, live: () => boolean): void {
		if (this.closed || cursor.empty || this.shed.dropsRecords) {
			cursor.release();
			return;
		}
		this.queue.push({ kind: "attach", barrier: new BaselineBarrier(cursor, live) });
		void this.drain();
	}

	/** `held`, for a record that reaches this peer because it holds a session: whether it still does. */
	enqueue(
		line: string,
		key?: string,
		onWritten?: () => void,
		demotedLine?: string,
		reply = false,
		held?: () => boolean,
		current?: () => boolean,
	): void {
		if (this.closed) return;
		const bytes = Buffer.byteLength(line);
		if (this.shed.dropsRecords) {
			if (reply) this.admitReply({ line, bytes, onWritten, reply, current });
			else onWritten?.();
			return;
		}
		if (key !== undefined) this.queue.supersede(key);
		if (!this.fits(bytes)) {
			if (this.recovery && this.recoveryEnabled) {
				if (this.shed.isPending) this.shed.supersede();
				else this.cut("overflow");
				// The cut covers this record; only a reply still needs its own place.
				if (reply) this.admitReply({ line, bytes, onWritten, reply, current });
				else onWritten?.();
				void this.drain();
				return;
			}
			this.failOverflow(bytes, line);
			return;
		}
		this.queue.push({
			line,
			bytes,
			key,
			demotedLine,
			onWritten,
			reply,
			held: this.shed.isPending ? held : undefined,
			current,
		});
		void this.drain();
	}

	async flush(): Promise<void> {
		while (this.draining) await this.draining;
		if (this.failure !== undefined) throw this.failure;
	}

	/**
	 * Resolve once every record enqueued so far has been ACCEPTED into this queue.
	 *
	 * `enqueue` admits a record synchronously, or fails closed on byte overflow, so
	 * acceptance is already settled by the time a caller asks - and it never waits for
	 * the peer to drain. This is the session worker's credit point (#1774); use
	 * `flush()` where the queue must actually reach the transport (close, shutdown).
	 */
	waitForAcceptance(): Promise<void> {
		return Promise.resolve();
	}

	close(): void {
		this.closed = true;
		this.dropQueue();
		this.stopped.abort();
	}

	private fits(bytes: number): boolean {
		return this.queue.bytes + this.frameBytes + bytes <= this.maxQueueBytes;
	}

	private admitReply(entry: QueueEntry): void {
		if (!this.fits(entry.bytes)) {
			this.recovery?.loseReply();
			entry.onWritten?.();
			return;
		}
		this.shed.admitReply(entry);
		void this.drain();
	}

	/** A plain peer's overflow: the notice, then fail closed so the client resyncs. */
	private failOverflow(bytes: number, line: string): void {
		const overflow = new SocketEventQueueOverflowError(
			this.queue.bytes + this.frameBytes,
			bytes,
			this.maxQueueBytes,
			line.slice(0, 120),
		);
		this.closed = true;
		this.dropQueue();
		try {
			this.sink.writeRaw(`${JSON.stringify({ type: "overflow", error: "overflow, resync required" })}\n`);
		} catch (cause) {
			this.onFailure(cause);
		}
		this.onFailure(overflow);
	}

	/** Ends every queued baseline and the one in flight, then empties the queue. */
	private dropQueue(): void {
		this.queue.clear();
		this.attempt?.cancel();
		this.shed.clear();
	}

	/** The stall deadline's shed: one cut per pending recovery, never a re-cut while the peer stays idle. */
	private cutOnce(reason: ResyncReason): void {
		if (!this.recovery?.pending) this.cut(reason);
	}

	private cut(reason: ResyncReason): void {
		if (!this.recovery || !this.snapshot) return;
		this.attempt?.cancel();
		this.recovery.shed(reason);
		this.shed.cut(reason, this.snapshot, () => !this.closed);
	}

	private async write(line: string): Promise<void> {
		this.sink.writeRaw(line);
		await waitForDrainOrStall(this.stallPeer, Buffer.byteLength(line));
	}

	/** An attach frame is charged like the replay line it replaces: one that does not fit sheds, or overflows a plain peer. */
	private async writeFrame(line: string): Promise<void> {
		const bytes = Buffer.byteLength(line);
		if (!this.fits(bytes)) {
			if (this.recovery && this.recoveryEnabled) this.cutOnce("overflow");
			else this.failOverflow(bytes, line);
			return;
		}
		this.frameBytes = bytes;
		try {
			await this.write(line);
		} finally {
			this.frameBytes = 0;
		}
	}

	private async deliver(entry: AttachEntry | RecoveryEntry): Promise<void> {
		if (entry.kind === "attach") {
			await this.stream(entry.barrier, (line) => this.writeFrame(line));
			return;
		}
		// A recovery first waits for the peer to drain again; then the gap opens the frames.
		await waitForDrainOrStall(this.stallPeer, 0);
		if (this.closed || !this.recovery) {
			entry.barrier.end();
			return;
		}
		const barrier = this.shed.take(entry, this.snapshot, () => !this.closed);
		const gap = this.recovery.takeGap();
		if (!this.recoveryEnabled) this.recovery = undefined;
		await this.stream(barrier, (line) => this.write(line), gap);
	}

	private async stream(
		barrier: BaselineBarrier,
		write: (line: string) => Promise<void>,
		head?: string,
	): Promise<void> {
		this.attempt = barrier;
		try {
			await barrier.deliver(write, head);
		} finally {
			barrier.end();
			if (this.attempt === barrier) this.attempt = undefined;
		}
	}

	private drain(): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = (async () => {
			try {
				while (!this.closed && this.queue.length > 0) {
					const item = this.queue.shift();
					if (item === undefined) break;
					if (isBarrier(item)) {
						await this.deliver(item);
						continue;
					}
					if ((item.held?.() ?? true) && (item.current?.() ?? true)) await this.write(item.line);
					item.onWritten?.();
				}
			} catch (cause) {
				this.failure = cause;
				this.closed = true;
				this.dropQueue();
				this.onFailure(cause);
			}
		})().finally(() => {
			this.draining = undefined;
			// An enqueue that lands between the loop's exit and this reaction sees the
			// stale settled promise and starts nothing; reschedule for it here.
			if (!this.closed && this.queue.length > 0) void this.drain();
		});
		return this.draining;
	}
}
