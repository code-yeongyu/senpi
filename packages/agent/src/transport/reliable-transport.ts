import {
	type CarrierConnection,
	type FrameHandler,
	type TransportClock,
	TransportClosedError,
	type TransportFrame,
	type TransportSide,
} from "./transport.ts";

/** The reference transport's wire messages: per-lane sequence numbers from 1, and cumulative ACKs of delivered frames. */
export type ReferencePacket =
	| { readonly kind: "data"; readonly lane: string; readonly seq: number; readonly payload: Uint8Array }
	| { readonly kind: "ack"; readonly lane: string; readonly seq: number };

export interface ReliableTransportOptions {
	readonly clock: TransportClock;
	/** Frames per lane that may be sent and unacknowledged at once. Default 32. */
	readonly window?: number;
	/**
	 * Without ACK progress on a lane for this long, that lane's unacknowledged frames are sent again from its last ACK.
	 * Each lane keeps its own deadline, so progress on one lane never postpones another's retransmit. Default 1000.
	 */
	readonly retransmitMs?: number;
	/** A receiver that throws: the frame still counts as delivered (it is never delivered twice). */
	readonly onHandlerError: (error: unknown, frame: TransportFrame) => void;
}

interface Waiter {
	readonly payload: Uint8Array;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

interface OutLane {
	nextSeq: number;
	acked: number;
	transmitted: number;
	readonly outbox: Map<number, Uint8Array>;
	readonly waiters: Waiter[];
	/** Cancels this lane's retransmit deadline; set while the lane has unacknowledged frames and a connection. */
	cancelRetransmit: (() => void) | undefined;
}

interface InLane {
	received: number;
	delivered: number;
	busy: boolean;
	readonly inbox: TransportFrame[];
}

function isReferencePacket(message: unknown): message is ReferencePacket {
	if (typeof message !== "object" || message === null) return false;
	const { kind, lane, seq } = message as Record<string, unknown>;
	if (typeof lane !== "string" || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return false;
	if (kind === "ack") return true;
	return kind === "data" && (message as { payload?: unknown }).payload instanceof Uint8Array;
}

/** The decoder a conformance host uses to watch the reference transport's wire. */
export function decodeReferencePacket(
	message: unknown,
): { readonly kind: "data" | "ack"; readonly lane: string; readonly seq: number } | { readonly kind: "other" } {
	return isReferencePacket(message) ? { kind: message.kind, lane: message.lane, seq: message.seq } : { kind: "other" };
}

/**
 * The reference transport: per-lane send windows (backpressure), round-robin transmission across lanes (fairness),
 * cumulative ACKs sent only after the receiver's handler settles, and go-back-N from each lane's last ACK on re-attach or
 * on that lane's own retransmit timeout. A receiver drops anything that is not the next frame of its lane, so it delivers each frame
 * once and in order over any carrier that may drop, lose, delay or reorder messages.
 */
export function createReliableTransport(options: ReliableTransportOptions): TransportSide {
	const window = options.window ?? 32;
	const retransmitMs = options.retransmitMs ?? 1000;
	const outLanes = new Map<string, OutLane>();
	const inLanes = new Map<string, InLane>();
	const order: string[] = [];
	const ackDue = new Set<string>();
	let next = 0;
	let connection: CarrierConnection | undefined;
	let writable = false;
	let closed = false;
	let handler: FrameHandler | undefined;

	const outLane = (lane: string): OutLane => {
		let state = outLanes.get(lane);
		if (state === undefined) {
			state = { nextSeq: 1, acked: 0, transmitted: 0, outbox: new Map(), waiters: [], cancelRetransmit: undefined };
			outLanes.set(lane, state);
			order.push(lane);
		}
		return state;
	};
	const inLane = (lane: string): InLane => {
		let state = inLanes.get(lane);
		if (state === undefined) {
			state = { received: 0, delivered: 0, busy: false, inbox: [] };
			inLanes.set(lane, state);
		}
		return state;
	};

	const admit = (state: OutLane): void => {
		while (state.nextSeq - 1 - state.acked < window) {
			const waiter = state.waiters.shift();
			if (waiter === undefined) return;
			state.outbox.set(state.nextSeq, waiter.payload);
			state.nextSeq += 1;
			waiter.resolve();
		}
	};

	const emit = (packet: ReferencePacket): boolean => {
		if (connection === undefined || !writable) return false;
		if (connection.send(packet)) return true;
		writable = false;
		return false;
	};

	const disarm = (state: OutLane): void => {
		state.cancelRetransmit?.();
		state.cancelRetransmit = undefined;
	};
	const disarmAll = (): void => {
		for (const state of outLanes.values()) disarm(state);
	};
	const arm = (): void => {
		if (connection === undefined) return;
		for (const state of outLanes.values()) {
			if (state.cancelRetransmit !== undefined || state.outbox.size === 0) continue;
			state.cancelRetransmit = options.clock.setTimer(() => {
				state.cancelRetransmit = undefined;
				state.transmitted = state.acked;
				pump();
			}, retransmitMs);
		}
	};

	function pump(): void {
		if (connection === undefined || !writable) return;
		for (const lane of [...ackDue]) {
			if (!emit({ kind: "ack", lane, seq: inLane(lane).delivered })) return;
			ackDue.delete(lane);
		}
		for (let idle = 0; idle < order.length;) {
			const lane = order[next % order.length];
			if (lane === undefined) return;
			const state = outLane(lane);
			const seq = state.transmitted + 1;
			const payload = state.outbox.get(seq);
			if (payload === undefined) {
				next += 1;
				idle += 1;
				continue;
			}
			if (!emit({ kind: "data", lane, seq, payload })) return;
			state.transmitted = seq;
			next += 1;
			idle = 0;
		}
		arm();
	}

	async function deliver(state: InLane, lane: string): Promise<void> {
		if (state.busy || handler === undefined) return;
		state.busy = true;
		try {
			for (let frame = state.inbox.shift(); frame !== undefined && !closed; frame = state.inbox.shift()) {
				try {
					await handler(frame);
				} catch (error) {
					options.onHandlerError(error, frame);
				}
				state.delivered += 1;
				ackDue.add(lane);
				pump();
			}
		} finally {
			state.busy = false;
		}
	}

	const onData = (packet: Extract<ReferencePacket, { kind: "data" }>): void => {
		const state = inLane(packet.lane);
		if (packet.seq === state.received + 1) {
			state.received = packet.seq;
			state.inbox.push({ lane: packet.lane, payload: packet.payload });
			void deliver(state, packet.lane);
		} else {
			ackDue.add(packet.lane);
		}
		pump();
	};

	const onAck = (packet: Extract<ReferencePacket, { kind: "ack" }>): void => {
		const state = outLanes.get(packet.lane);
		if (state === undefined || packet.seq <= state.acked || packet.seq >= state.nextSeq) return;
		for (let seq = state.acked + 1; seq <= packet.seq; seq++) state.outbox.delete(seq);
		state.acked = packet.seq;
		state.transmitted = Math.max(state.transmitted, state.acked);
		disarm(state);
		admit(state);
		pump();
	};

	return {
		send(lane, payload) {
			if (closed) return Promise.reject(new TransportClosedError());
			const state = outLane(lane);
			return new Promise<void>((resolve, reject) => {
				state.waiters.push({ payload, resolve, reject });
				admit(state);
				pump();
			});
		},
		onFrame(frameHandler) {
			handler = frameHandler;
			for (const [lane, state] of inLanes) void deliver(state, lane);
		},
		inFlight: (lane) => {
			const state = outLanes.get(lane);
			return state === undefined ? 0 : state.nextSeq - 1 - state.acked;
		},
		close() {
			if (closed) return;
			closed = true;
			disarmAll();
			for (const state of outLanes.values()) {
				for (const waiter of state.waiters.splice(0)) waiter.reject(new TransportClosedError());
			}
			const current = connection;
			connection = undefined;
			current?.close();
		},
		attached(newConnection) {
			if (closed) {
				newConnection.close();
				return;
			}
			connection = newConnection;
			writable = true;
			for (const state of outLanes.values()) state.transmitted = state.acked;
			for (const [lane, state] of inLanes) if (state.delivered > 0) ackDue.add(lane);
			disarmAll();
			pump();
		},
		message(message) {
			if (!isReferencePacket(message)) return;
			if (message.kind === "data") onData(message);
			else onAck(message);
		},
		writable() {
			if (connection === undefined) return;
			writable = true;
			pump();
		},
		detached() {
			connection = undefined;
			writable = false;
			disarmAll();
		},
	};
}
