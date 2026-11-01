import { serializeJsonLine } from "./jsonl.ts";
import type { LegacyViewCursor } from "./legacy-view-cursor.ts";

export const EVENT_RESYNC_CAPABILITY = "event_resync";
export type ResyncReason = "overflow" | "stall";
/**
 * A shed's recovery cut: read by the peer's barrier after the gap, released on every end. `sessions` are the ones
 * it reports, carried into a re-cut so a session detached in between is still reported closed.
 */
export type ResyncCut = LegacyViewCursor & { readonly sessions: readonly string[] };
export type RpcSessionResyncRequired = {
	readonly type: "resync_required";
	readonly sessionId: string;
	readonly reason: ResyncReason;
	readonly message: unknown;
	readonly closed?: true;
};

export function isCorrelatedReply(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "response" &&
		"id" in value &&
		typeof value.id === "string"
	);
}

class SocketPeerLivenessError extends Error {
	constructor() {
		super("socket peer missed its liveness ping");
		this.name = "SocketPeerLivenessError";
	}
}

/** One gap and one outstanding ping, regardless of how many events the producer emits. */
export class SocketPeerRecovery {
	private reason: ResyncReason | undefined;
	private awaitingPing = false;
	private pingBuffered = false;
	private replyLost = false;
	private readonly write: (line: string) => void;

	constructor(write: (line: string) => void) {
		this.write = write;
		// Negotiate the heartbeat before session traffic can fill the output side.
		// Pulses travel client -> host even while host -> client is backpressured.
		this.pingBuffered = true;
		this.write(serializeJsonLine({ type: "rpc_ping" }));
	}

	get pending(): boolean {
		return this.reason !== undefined;
	}

	/** The first shed names the gap's reason; a supersession while pending keeps it. */
	shed(reason: ResyncReason): void {
		this.reason ??= reason;
	}

	/** A fresh set_client_info is the existing connection-scoped acknowledgement. */
	acknowledge(): void {
		this.awaitingPing = false;
	}

	loseReply(): void {
		this.replyLost = true;
	}

	ping(): void {
		if (this.awaitingPing) throw new SocketPeerLivenessError();
		this.awaitingPing = true;
		if (!this.pingBuffered) {
			this.pingBuffered = true;
			this.write(serializeJsonLine({ type: "rpc_ping" }));
		}
	}

	/** The gap line that opens the recovery; taken once the peer drains again, before the cut's frames. */
	takeGap(): string {
		const reason = this.reason;
		this.reason = undefined;
		this.awaitingPing = false;
		this.pingBuffered = false;
		const replyLost = this.replyLost;
		this.replyLost = false;
		return serializeJsonLine({ type: "resync_required", reason, replyLost });
	}
}
