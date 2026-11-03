import type { DurableStore } from "../durable/store.ts";
import type { AdmissionLine } from "../durable/store-admission.ts";
import type { WakeEvent, WakeInboxRecord, WakeReceipt } from "./wake-types.ts";

export interface WakeInboxOptions {
	readonly issuer: string;
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
	readonly clock: () => number;
	/** The authenticated hand bound to a scope (design 5.6.6), or undefined for a scope this brain does not own. */
	readonly owner: (scope: string) => string | undefined;
}

/** The brain side of design 5.6.4: deduplicated by event id, acked only after the commit. */
export interface WakeInbox {
	/** `sender` is the authenticated hand. The returned `ack` is the `wake_ack` to send; it exists only once committed. */
	receive(sender: string, wake: WakeEvent): Promise<WakeReceipt>;
	/** Hands each committed wake to the loop, then removes it; a crash in between hands it over again (dedup by id). */
	drain(consume: (wake: WakeEvent) => Promise<void>): Promise<number>;
	closeScope(scope: string): Promise<void>;
	/** Forgets the event ids of scopes closed longer ago than the retention. */
	sweep(): Promise<readonly string[]>;
	read(): Promise<WakeInboxRecord>;
}

export function createWakeInbox(_options: WakeInboxOptions): WakeInbox {
	return {
		receive: async (_sender, wake) => ({ kind: "ack", eventId: wake.eventId, duplicate: false }),
		drain: async () => 0,
		closeScope: async () => {},
		sweep: async () => [],
		read: async () => ({ seen: {}, pending: [], closed: {} }),
	};
}
