import type { StoreValue } from "../durable/store.ts";

/** Design 5.6.4: an un-acked wake lives until its scope closes plus this long, then it is dropped as `wake_expired`. */
export const WAKE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One durable wake from a hand to the brain that owns its scope. `eventId` is unique per hand and stable on re-offer. */
export type WakeEvent = {
	readonly eventId: string;
	readonly scope: string;
	readonly source: string;
	readonly payload: StoreValue;
};

/**
 * Why the brain refused a wake. `not_scope_session` (senpi#6767 review L3): the wake names a loop session that is not
 * one of its scope's sessions.
 */
export type WakeRefusal = "not_scope_hand" | "unknown_scope" | "scope_closed" | "not_scope_session";

/**
 * Why wakes never reached the brain: `overflow` (the hand's un-acked bound, oldest first), `expired` (un-acked past
 * the closed scope's retention), `malformed` (an entry the hand's outbox could not read), `unrecorded` (the hand could
 * not commit it at all; reported best-effort, as it has no durable record).
 */
export type WakeDropReason = "overflow" | "expired" | "malformed" | "unrecorded";

/** The source of a drop report: a durable wake whose payload is `{ reason, count }` (a {@link WakeDropReason}). */
export const WAKE_DROPPED_SOURCE = "wake.dropped";

/** The un-acked wakes a hand keeps, per scope and in total; past either the oldest is dropped (`overflow`). */
export interface WakeLimits {
	readonly perScope: number;
	readonly total: number;
}

/** What the brain answers a wake: `ack` only after the inbox commit; a refusal commits nothing and is never acked. */
export type WakeReceipt =
	| { readonly kind: "ack"; readonly eventId: string; readonly duplicate: boolean }
	| { readonly kind: "refused"; readonly eventId: string; readonly reason: WakeRefusal };

export type WakeOutboxRecord = {
	readonly pending: readonly WakeEvent[];
	/** Drop reports not yet acked (source {@link WAKE_DROPPED_SOURCE}); acked and expired like wakes, never bounded by limits. */
	readonly drops: readonly WakeEvent[];
	/** Wakes the brain refused for good, by event id, with the refusal time: never re-offered, dropped after the retention. */
	readonly refused: { readonly [eventId: string]: { readonly reason: WakeRefusal; readonly at: number } };
	/** Scopes the hand closed, with the close time that starts their retention. */
	readonly closed: { readonly [scope: string]: number };
};

export type WakeInboxRecord = {
	/** Every committed event id per scope: a re-offer is a duplicate, never a second wake. */
	readonly seen: { readonly [scope: string]: readonly string[] };
	/** Committed and not yet taken by the brain's loop, in commit order. */
	readonly pending: readonly WakeEvent[];
	/** Scopes the brain closed, with the close time; kept after their seen ids are dropped, so a late wake is refused. */
	readonly closed: { readonly [scope: string]: number };
};
