import type { StoreValue } from "../durable/store.ts";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import type { WakeInbox } from "./wake-inbox.ts";
import type { WakeOutbox } from "./wake-outbox.ts";
import type { WakeEvent, WakeReceipt, WakeRefusal } from "./wake-types.ts";

/**
 * The wake link (brain/hand split H3, design 5.6.4 on the hand transport): what a hand's work produces after the call
 * that started it ended reaches the brain that owns its scope at least once, or the brain is told it was dropped. The
 * hand commits each wake to its durable outbox before sending it; the brain answers with a receipt only after its inbox
 * commit; the hand re-offers every un-acked wake when it starts and whenever the brain asks. Everything travels on one
 * lane of the hand's transport, so a relay carries it like any other lane: frames from the hand wait for the brain's
 * next batch.
 */
export const HAND_WAKE_LANE = "hand.wake";

/** Why wakes never reached the brain: kept un-acked past the closed scope's retention, or never recorded on the hand. */
export type WakeDropReason = "expired" | "unrecorded";

export interface WakeDrop {
	readonly scope: string;
	readonly reason: WakeDropReason;
	readonly count: number;
}

export type WakeLinkMessage =
	| { readonly kind: "wake"; readonly wake: WakeEvent }
	| ({ readonly kind: "wake_dropped" } & WakeDrop)
	| { readonly kind: "wake_receipt"; readonly receipt: WakeReceipt }
	| { readonly kind: "wake_reoffer" };

const REFUSALS: readonly WakeRefusal[] = ["not_scope_hand", "unknown_scope", "scope_closed"];
const DROP_REASONS: readonly WakeDropReason[] = ["expired", "unrecorded"];
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
			return isId(value.scope) &&
				DROP_REASONS.includes(value.reason as WakeDropReason) &&
				typeof value.count === "number" &&
				Number.isSafeInteger(value.count) &&
				value.count > 0
				? { kind: "wake_dropped", scope: value.scope, reason: value.reason as WakeDropReason, count: value.count }
				: undefined;
		case "wake_reoffer":
			return { kind: "wake_reoffer" };
		default:
			return undefined;
	}
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
	/** Settles once the start re-offer has sent every wake a previous process left un-acked. */
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
	const dropped = (drop: WakeDrop): Promise<void> => send({ kind: "wake_dropped", ...drop });
	// Wakes expired since the last re-offer are reported per scope first; then every due wake is sent again (the brain's
	// inbox answers a duplicate with its ack, so a re-send never wakes the loop twice).
	const reoffer = async (): Promise<void> => {
		const before = await outbox.pending();
		const expired = new Set(await outbox.sweep());
		const counts = new Map<string, number>();
		for (const wake of before)
			if (expired.has(wake.eventId)) counts.set(wake.scope, (counts.get(wake.scope) ?? 0) + 1);
		for (const [scope, count] of counts) await dropped({ scope, reason: "expired", count });
		for (const wake of await outbox.due()) await send({ kind: "wake", wake });
	};
	transport.onFrame(async (frame: TransportFrame) => {
		const message = decodeWakeLinkMessage(frame.payload);
		try {
			if (message?.kind === "wake_receipt") await outbox.receipt(message.receipt);
			else if (message?.kind === "wake_reoffer") await reoffer();
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
				onFault(error);
				return dropped({ scope: wake.scope, reason: "unrecorded", count: 1 });
			}
			return send({ kind: "wake", wake: event });
		},
		closeScope: (scope) => outbox.closeScope(scope).catch(onFault),
		close() {
			closed = true;
		},
	};
}

export interface BrainWakeLinkOptions {
	/** The brain's end of its link to one hand; only {@link lane} frames reach this link. */
	readonly transport: Transport;
	readonly lane?: string;
	/** The brain's durable inbox; it decides which scopes this hand may wake (its `owner`). */
	readonly inbox: WakeInbox;
	/** The authenticated hand at the other end of this link (design 5.6.6), the inbox's `sender`. */
	readonly hand: string;
	/** A wake the inbox committed for the first time: the brain drains the inbox to deliver it. */
	readonly onCommitted: (wake: WakeEvent) => void;
	/** Wakes the hand reports it could not deliver: the loop is told instead of never hearing of them. */
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
	transport.onFrame(async (frame: TransportFrame) => {
		if (closed) return;
		const message = decodeWakeLinkMessage(frame.payload);
		try {
			if (message?.kind === "wake") {
				const receipt = await inbox.receive(hand, message.wake);
				send({ kind: "wake_receipt", receipt });
				if (receipt.kind === "ack" && !receipt.duplicate) options.onCommitted(message.wake);
			} else if (message?.kind === "wake_dropped")
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
