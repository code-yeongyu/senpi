import { serializeJsonLine } from "./jsonl.ts";
import { SocketEventQueueOverflowError, SocketEventQueueStallError } from "./socket-event-queue-errors.ts";

/**
 * RULING-124 (#5322): the engine never closes a compact peer's socket without saying why. Every engine-initiated close
 * takes one of these codes, and a peer that selected compact events receives `socket_closing {code, retryable,
 * detail?}` as its last record before the close. `retryable` is fixed per code: true when the cause belongs to this
 * connection, so a new one with the same selection may succeed; false when it would get the same answer.
 */
export const SOCKET_CLOSING_CODES = {
	/** A required or mirrored stream's checkpoint could not be frozen (compact storage or generation space). */
	checkpoint_unavailable: { retryable: true },
	/** The connection's event queue failed: byte overflow, a missed liveness deadline, or a transport write error. */
	event_queue_failed: { retryable: true },
	/** An event could not be leased: the peer's lease bound, or the content could not be staged. */
	event_lease_refused: { retryable: true },
	/** A compact mirror of a session this host serves only on the legacy wire. */
	compact_endpoint_unsupported: { retryable: false },
	/** The host is shutting down, after its sessions' `session_closed` records. */
	host_shutdown: { retryable: true },
	/** The host is draining for a newer generation, after its sessions' handoff park records. */
	host_handoff: { retryable: true },
} as const satisfies Readonly<Record<string, { readonly retryable: boolean }>>;

export type SocketClosingCode = keyof typeof SOCKET_CLOSING_CODES;

/** The record a compact peer receives last before an engine-initiated close; best effort, never guaranteed. */
export interface RpcSocketClosingEvent {
	readonly type: "socket_closing";
	readonly code: SocketClosingCode;
	readonly retryable: boolean;
	readonly detail?: string;
}

/** How long the engine waits for `socket_closing` to drain before it closes regardless (RULING-124 (a)). */
const SOCKET_CLOSING_FLUSH_MS = 1_000;

interface ClosingTransport {
	readonly writeRaw: (chunk: string) => void;
	readonly waitForBackpressure: () => Promise<void>;
	readonly close?: () => void;
}

/** Transports already announcing their close: a second engine close of the same peer writes nothing more. */
const closing = new WeakSet<ClosingTransport>();

/**
 * The one way the engine closes a peer's socket. A legacy or flag-off peer is closed exactly as before, synchronously
 * and with no new bytes. A compact peer's record queue is stopped first, so nothing follows the record, then
 * `socket_closing` is written and the close waits for it to drain for at most `SOCKET_CLOSING_FLUSH_MS`; a broken transport (the write
 * throws or the drain rejects) is closed at once (RULING-124 (a), (b)).
 */
export function closeSocket(
	transport: ClosingTransport,
	queue: { close(): void },
	compact: boolean,
	code: SocketClosingCode,
	detail?: string,
): Promise<void> {
	if (!compact) {
		transport.close?.();
		return Promise.resolve();
	}
	if (closing.has(transport)) return Promise.resolve();
	closing.add(transport);
	queue.close();
	const { retryable } = SOCKET_CLOSING_CODES[code];
	const record: RpcSocketClosingEvent = {
		type: "socket_closing",
		code,
		retryable,
		...(detail === undefined ? {} : { detail }),
	};
	let drained: Promise<void>;
	try {
		transport.writeRaw(serializeJsonLine(record));
		drained = transport.waitForBackpressure();
	} catch (cause) {
		drained = Promise.reject(cause);
	}
	return settledWithin(drained, SOCKET_CLOSING_FLUSH_MS).then((failure) => {
		if (failure !== undefined)
			process.stderr.write(`senpi rpc socket_closing (${code}) not delivered: ${failure}; closing\n`);
		transport.close?.();
	});
}

function settledWithin(drained: Promise<void>, ms: number): Promise<string | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<undefined>((resolve) => {
		timer = setTimeout(resolve, ms, undefined);
		timer.unref?.();
	});
	const settled = drained.then(
		() => undefined,
		(cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
	);
	return Promise.race([settled, bound]).finally(() => clearTimeout(timer));
}

/** The `detail` of an `event_queue_failed` close: which of the queue's failures ended it. */
export function queueFailureDetail(cause: unknown): string {
	if (cause instanceof SocketEventQueueOverflowError) return "overflow";
	if (cause instanceof SocketEventQueueStallError) return "stall";
	return "transport_error";
}
