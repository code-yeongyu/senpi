import { loopBlockedMark, loopBlockedMsSince } from "./loop-blocked-time.ts";
import { SocketEventQueueStallError } from "./socket-event-queue-errors.ts";

export interface DrainStallPeer {
	readonly sink: { writeRaw(chunk: string): void; waitForBackpressure(): Promise<void> };
	readonly stallMs: number;
	readonly stopped: AbortSignal;
	/** Bytes still queued behind the write, reported by the stall error. */
	readonly queuedBytes: () => number;
	/** A resync-capable peer sheds and pings at the deadline instead of being cut; false for a plain legacy peer. */
	readonly shedAndPing: () => boolean;
}

/**
 * Resolve when the sink accepted the write, or throw SocketEventQueueStallError
 * once the peer has held the transport full for stallMs. The notice may only reach
 * the sink's buffer - the peer is not draining - so the transport delivers it on
 * close by half-closing the socket and destroying it only after a bounded grace
 * (socket-sink.ts).
 */
export function waitForDrainOrStall(peer: DrainStallPeer, writtenBytes: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		let blockedMark = loopBlockedMark();
		const cleanup = (): void => {
			clearTimeout(timer);
			peer.stopped.removeEventListener("abort", onStop);
		};
		const onStop = (): void => {
			cleanup();
			resolve();
		};
		const onDeadline = (): void => {
			const blockedMs = loopBlockedMsSince(blockedMark);
			if (blockedMs > 0) {
				blockedMark = loopBlockedMark();
				timer = setTimeout(onDeadline, Math.min(blockedMs, peer.stallMs));
				return;
			}
			try {
				if (peer.shedAndPing()) {
					blockedMark = loopBlockedMark();
					timer = setTimeout(onDeadline, peer.stallMs);
					return;
				}
			} catch (cause) {
				cleanup();
				reject(cause);
				return;
			}
			const stall = new SocketEventQueueStallError(peer.queuedBytes() + writtenBytes, peer.stallMs);
			try {
				peer.sink.writeRaw(`${JSON.stringify({ type: "overflow", error: "stalled, resync required" })}\n`);
			} catch {
				// The peer is unreachable either way; the failure below closes it.
			}
			cleanup();
			reject(stall);
		};
		timer = setTimeout(onDeadline, peer.stallMs);
		peer.stopped.addEventListener("abort", onStop, { once: true });
		peer.sink.waitForBackpressure().then(
			() => {
				cleanup();
				resolve();
			},
			(cause) => {
				cleanup();
				reject(cause);
			},
		);
	});
}
