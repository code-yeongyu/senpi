import type { StoreValue } from "../durable/store.ts";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import type { WakeInbox } from "./wake-inbox.ts";
import { type WakeOutbox, WakeOverflowError } from "./wake-outbox.ts";
import {
	WAKE_DROPPED_SOURCE,
	type WakeDropReason,
	type WakeEvent,
	type WakeReceipt,
	type WakeRefusal,
} from "./wake-types.ts";

/**
 * The wake link (brain/hand split H3, design 5.6.4 on the hand transport): what a hand's work produces after the call
 * that started it ended reaches the brain that owns its scope at least once, or the brain is told it was dropped. The
 * hand commits each wake to its durable outbox before sending it; the brain answers with a receipt only after its inbox
 * commit; the hand re-offers every un-acked wake when it starts and whenever the brain asks. Everything travels on one
 * lane of the hand's transport, so a relay carries it like any other lane: frames from the hand wait for the brain's
 * next batch.
 */
export const HAND_WAKE_LANE = "hand.wake";

export type { WakeDropReason };

/** What the hand reports dropped: `count` wakes of `scope`, for `reason`. */
export interface WakeDrop {
	readonly scope: string;
	readonly reason: WakeDropReason;
	readonly count: number;
}

/**
 * A `wake_dropped` with an `eventId` is a durable drop report: the brain commits it to its inbox like a wake (source
 * {@link WAKE_DROPPED_SOURCE}), so it is delivered once and acked with a `wake_receipt`. Without one (reason
 * `unrecorded`) it is best-effort and goes to `onDropped`.
 */
export type WakeLinkMessage =
	| { readonly kind: "wake"; readonly wake: WakeEvent }
	| ({ readonly kind: "wake_dropped"; readonly eventId?: string } & WakeDrop)
	| { readonly kind: "wake_receipt"; readonly receipt: WakeReceipt }
	| { readonly kind: "wake_reoffer" };

const REFUSALS: readonly WakeRefusal[] = ["not_scope_hand", "unknown_scope", "scope_closed", "not_scope_session"];
const DROP_REASONS: readonly WakeDropReason[] = ["overflow", "expired", "refused", "malformed", "unrecorded"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function encodeWakeLinkMessage(message: WakeLinkMessage): Uint8Array {
	return encoder.encode(JSON.stringify(message));
}

function decodeWake(value: unknown): WakeEvent | undefined {
	if (!isRecord(value) || !isId(value.eventId) || !isId(value.scope) || !isId(value.source) || !("payload" in value))
		return undefined;
	return { eventId: value.eventId, scope: value.scope, source: value.source, payload: value.payload as StoreValue };
}

function decodeReceipt(value: unknown): WakeReceipt | undefined {
	if (!isRecord(value) || !isId(value.eventId)) return undefined;
	if (value.kind === "ack" && typeof value.duplicate === "boolean")
		return { kind: "ack", eventId: value.eventId, duplicate: value.duplicate };
	if (value.kind === "refused" && REFUSALS.includes(value.reason as WakeRefusal))
		return { kind: "refused", eventId: value.eventId, reason: value.reason as WakeRefusal };
	return undefined;
}

function decodeDrop(value: Record<string, unknown>): WakeLinkMessage | undefined {
	const { scope, reason, count, eventId } = value;
	if (!isId(scope) || !DROP_REASONS.includes(reason as WakeDropReason)) return undefined;
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) return undefined;
	if (eventId !== undefined && !isId(eventId)) return undefined;
	const drop = { kind: "wake_dropped" as const, scope, reason: reason as WakeDropReason, count };
	return eventId === undefined ? drop : { ...drop, eventId };
}

/** Parses one frame payload as a wake-link message; anything else is `undefined`. */
export function decodeWakeLinkMessage(payload: Uint8Array): WakeLinkMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(payload));
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	switch (value.kind) {
		case "wake": {
			const wake = decodeWake(value.wake);
			return wake === undefined ? undefined : { kind: "wake", wake };
		}
		case "wake_receipt": {
			const receipt = decodeReceipt(value.receipt);
			return receipt === undefined ? undefined : { kind: "wake_receipt", receipt };
		}
		case "wake_dropped":
			return decodeDrop(value);
		case "wake_reoffer":
			return { kind: "wake_reoffer" };
		default:
			return undefined;
	}
}

/** The frame a due outbox entry travels as: a drop report as `wake_dropped` with its event id, any other as `wake`. */
function frameOf(wake: WakeEvent): WakeLinkMessage {
	const { payload } = wake;
	if (wake.source !== WAKE_DROPPED_SOURCE || !isRecord(payload)) return { kind: "wake", wake };
	const { reason, count } = payload;
	return {
		kind: "wake_dropped",
		eventId: wake.eventId,
		scope: wake.scope,
		reason: reason as WakeDropReason,
		count: Number(count),
	};
}

export interface HandWakeLinkOptions {
	/** The hand's end of its link to the brain; only {@link lane} frames reach this link. */
	readonly transport: Transport;
	readonly lane?: string;
	readonly outbox: WakeOutbox;
	/** A wake that could not be recorded or sent, or a receipt that could not be applied. Reported, never thrown. */
	readonly onFault: (error: unknown) => void;
}

export interface HandWakeLink {
	/** Settles once the start re-offer has sent every wake and drop report a previous process left un-acked. */
	readonly ready: Promise<void>;
	/**
	 * Commits the wake, then sends it. A wake that cannot be committed is reported to the brain as dropped
	 * (`unrecorded`) and to `onFault`; it never throws into the work that produced it.
	 */
	offer(wake: Omit<WakeEvent, "eventId">): Promise<void>;
	/** The scope closed on the hand: its un-acked wakes are kept for the retention, then reported dropped. */
	closeScope(scope: string): Promise<void>;
	close(): void;
}

/** The hand end of the wake link: the durable outbox, sent over the transport, re-offered on start and on request. */
export function createHandWakeLink(options: HandWakeLinkOptions): HandWakeLink {
	const { transport, outbox, onFault } = options;
	const lane = options.lane ?? HAND_WAKE_LANE;
	let closed = false;
	const send = (message: WakeLinkMessage): Promise<void> => {
		if (closed) return Promise.resolve();
		return transport.send(lane, encodeWakeLinkMessage(message)).catch(onFault);
	};
	// Expired and malformed entries become drop reports first; then every report and un-acked wake is sent again (the
	// brain's inbox answers a duplicate with its ack, so a re-send never wakes the loop twice).
	const reoffer = async (): Promise<void> => {
		await outbox.sweep();
		for (const wake of await outbox.due()) await send(frameOf(wake));
	};
	transport.onFrame(async (frame: TransportFrame) => {
		const message = decodeWakeLinkMessage(frame.payload);
		try {
			if (message === undefined) onFault(new Error(`an undecodable frame on ${lane} was dropped`));
			else if (message.kind === "wake_receipt") await outbox.receipt(message.receipt);
			else if (message.kind === "wake_reoffer") await reoffer();
		} catch (error) {
			onFault(error);
		}
	});
	const ready = reoffer().catch(onFault);
	return {
		ready,
		async offer(wake) {
			let event: WakeEvent;
			try {
				event = await outbox.offer(wake);
			} catch (error) {
				// An overflow is already recorded as a durable drop report; anything else left no record at all.
				if (error instanceof WakeOverflowError) return;
				onFault(error);
				return send({ kind: "wake_dropped", scope: wake.scope, reason: "unrecorded", count: 1 });
			}
			return send({ kind: "wake", wake: event });
		},
		closeScope: (scope) => outbox.closeScope(scope).catch(onFault),
		close() {
			closed = true;
		},
	};
}

/** The brain refused a wake by its own check (`check`): it names a session that is not its scope's. */
export class WakeRefusedError extends Error {
	override readonly name = "WakeRefusedError";
	readonly wake: WakeEvent;
	readonly reason: WakeRefusal;
	constructor(wake: WakeEvent, reason: WakeRefusal) {
		super(`the brain refused wake ${wake.eventId} of scope ${wake.scope}: ${reason}`);
		this.wake = wake;
		this.reason = reason;
	}
}

export interface BrainWakeLinkOptions {
	/** The brain's end of its link to one hand; only {@link lane} frames reach this link. */
	readonly transport: Transport;
	readonly lane?: string;
	/** The brain's durable inbox; it decides which scopes this hand may wake (its `owner`). */
	readonly inbox: WakeInbox;
	/** The authenticated hand at the other end of this link (design 5.6.6), the inbox's `sender`. */
	readonly hand: string;
	/**
	 * The brain's own check of a wake before it is committed (senpi#6767 review L3), for example that the loop session
	 * it names belongs to its scope. A refusal is answered to the hand and reported to `onFault`; nothing is committed.
	 */
	readonly check?: (wake: WakeEvent) => WakeRefusal | undefined;
	/** A wake or drop report the inbox committed for the first time: the brain drains the inbox to deliver it. */
	readonly onCommitted: (wake: WakeEvent) => void;
	/** A best-effort drop report (`unrecorded`: the hand could not record the wake at all, so nothing is durable). */
	readonly onDropped: (drop: WakeDrop) => void;
	readonly onFault: (error: unknown) => void;
}

export interface BrainWakeLink {
	/** Asks the hand to send every wake it holds un-acked again (after a scope is bound, or a brain restart). */
	reoffer(): void;
	close(): void;
}

/** The brain end of the wake link: each wake goes to the inbox, and the receipt goes back only after its commit. */
export function serveHandWakes(options: BrainWakeLinkOptions): BrainWakeLink {
	const { transport, inbox, hand, onFault } = options;
	const lane = options.lane ?? HAND_WAKE_LANE;
	let closed = false;
	const send = (message: WakeLinkMessage): void => {
		if (!closed) transport.send(lane, encodeWakeLinkMessage(message)).catch(onFault);
	};
	const commit = async (wake: WakeEvent): Promise<void> => {
		// The brain's own check runs inside the inbox, after its scope binding: an unbound scope is `unknown_scope` (the
		// hand retries it), so only a bound scope's own answer can refuse a wake for good (review round 2, M4).
		const check = wake.source === WAKE_DROPPED_SOURCE ? undefined : options.check;
		const receipt = await inbox.receive(hand, wake, check);
		if (receipt.kind === "refused" && receipt.reason === "not_scope_session")
			onFault(new WakeRefusedError(wake, receipt.reason));
		send({ kind: "wake_receipt", receipt });
		if (receipt.kind === "ack" && !receipt.duplicate) options.onCommitted(wake);
	};
	transport.onFrame(async (frame: TransportFrame) => {
		if (closed) return;
		const message = decodeWakeLinkMessage(frame.payload);
		try {
			if (message === undefined) onFault(new Error(`an undecodable frame on ${lane} was dropped`));
			else if (message.kind === "wake") await commit(message.wake);
			else if (message.kind === "wake_dropped" && message.eventId !== undefined) {
				const { eventId, scope, reason, count } = message;
				await commit({ eventId, scope, source: WAKE_DROPPED_SOURCE, payload: { reason, count } });
			} else if (message.kind === "wake_dropped")
				options.onDropped({ scope: message.scope, reason: message.reason, count: message.count });
		} catch (error) {
			onFault(error);
		}
	});
	return {
		reoffer: () => send({ kind: "wake_reoffer" }),
		close() {
			closed = true;
		},
	};
}
