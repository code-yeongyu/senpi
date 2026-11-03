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

/** What the brain answers a wake: `ack` only after the inbox commit; a refusal commits nothing and is never acked. */
export type WakeReceipt =
	| { readonly kind: "ack"; readonly eventId: string; readonly duplicate: boolean }
	| { readonly kind: "refused"; readonly eventId: string; readonly reason: "not_scope_hand" | "unknown_scope" };

export type WakeOutboxRecord = {
	readonly pending: readonly WakeEvent[];
	/** Scopes the hand closed, with the close time that starts their retention. */
	readonly closed: { readonly [scope: string]: number };
};

export type WakeInboxRecord = {
	/** Every committed event id per scope: a re-offer is a duplicate, never a second wake. */
	readonly seen: { readonly [scope: string]: readonly string[] };
	/** Committed and not yet taken by the brain's loop, in commit order. */
	readonly pending: readonly WakeEvent[];
	readonly closed: { readonly [scope: string]: number };
};
