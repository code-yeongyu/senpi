import type { DurableStore, StoreValue } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import type { WakeEvent, WakeReceipt } from "./wake-types.ts";

export interface WakeOutboxOptions {
	/** The hand this outbox belongs to; every event id it mints starts with it. */
	readonly hand: string;
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
	readonly clock: () => number;
}

/** The hand side of design 5.6.4: a wake is durable before it is sent and removed only by its `wake_ack`. */
export interface WakeOutbox {
	/** Commits the wake and returns it; the caller sends it (or a later `reoffer` does). */
	offer(wake: Omit<WakeEvent, "eventId">): Promise<WakeEvent>;
	/** Sends every un-acked wake in offer order (on reconnect); a refused or failed send leaves it pending. */
	reoffer(send: (wake: WakeEvent) => Promise<WakeReceipt>): Promise<number>;
	/** Applies one brain answer: an ack removes the wake; a refusal keeps it for retention. Idempotent. */
	receipt(receipt: WakeReceipt): Promise<void>;
	/** The scope closed: its un-acked wakes are kept until `closedAt + WAKE_RETENTION_MS`. */
	closeScope(scope: string): Promise<void>;
	/** Drops the wakes past retention, each with a logged `wake_expired` record; returns their ids. */
	sweep(): Promise<readonly string[]>;
	pending(): Promise<readonly WakeEvent[]>;
}

export const isStoreObject = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	value !== null && typeof value === "object" && !Array.isArray(value);

export function createWakeOutbox(_options: WakeOutboxOptions): WakeOutbox {
	return {
		offer: async (wake) => ({ ...wake, eventId: "stub" }),
		reoffer: async () => 0,
		receipt: async () => {},
		closeScope: async () => {},
		sweep: async () => [],
		pending: async () => [],
	};
}
