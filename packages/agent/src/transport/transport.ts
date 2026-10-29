/**
 * The Transport contract of the durable core (packages/agent/docs/durable-core-adr.md, "Transport").
 *
 * A transport delivers opaque payloads between two endpoints on named lanes (one lane per scope). It owns per-lane order,
 * exactly-once delivery of each frame while both endpoints live, resume after the carrier drops and re-attaches, and
 * backpressure. Loops, hands, command IDs, epochs, deduplication of commands, consent, fencing and credentials are
 * endpoint duties; a transport never inspects a payload.
 */

/** One delivered frame: the lane it was sent on and its opaque payload. */
export interface TransportFrame {
	readonly lane: string;
	readonly payload: Uint8Array;
}

/** Receives frames. A lane's next frame is delivered only after this settles for the previous one; lanes are independent. */
export type FrameHandler = (frame: TransportFrame) => void | Promise<void>;

/** One endpoint of a transport link. */
export interface Transport {
	/**
	 * Queues `payload` on `lane`. Resolves once the frame is inside the lane's send window, so a lane whose receiver falls
	 * behind holds its own senders and nobody else's. Rejects with {@link TransportClosedError} after `close()`.
	 */
	send(lane: string, payload: Uint8Array): Promise<void>;
	/** Sets the receiver. Frames that arrived earlier are delivered once it is set. */
	onFrame(handler: FrameHandler): void;
	/** Frames on `lane` that were sent and not yet acknowledged by the peer. */
	inFlight(lane: string): number;
	close(): void;
}

/**
 * A message channel under a transport (in process, a local socket, the relay). It is ordered while it lasts, may drop
 * at any time, and under faults may lose or delay messages. Messages are opaque to it.
 */
export interface CarrierConnection {
	/** Hands `message` to the carrier. `false` means it was not taken; the side waits for `writable()` and sends again. */
	send(message: unknown): boolean;
	close(): void;
}

/** What a carrier calls on the endpoint it serves. */
export interface CarrierSide {
	/** A new connection is up (the first, or a re-attach after a drop). */
	attached(connection: CarrierConnection): void;
	message(message: unknown): void;
	/** The current connection takes messages again after a refused `send`. */
	writable(): void;
	/** The current connection is gone; anything in flight on it is lost. */
	detached(): void;
}

/** A transport endpoint as a carrier sees it. */
export interface TransportSide extends Transport, CarrierSide {}

/** The clock a transport schedules on; tests pass manual timers. */
export interface TransportClock {
	now(): number;
	/** Runs `callback` after `ms`; the returned function cancels it. */
	setTimer(callback: () => unknown, ms: number): () => void;
}

export class TransportClosedError extends Error {
	constructor() {
		super("transport closed");
		this.name = "TransportClosedError";
	}
}
