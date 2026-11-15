import {
	createAdmissionLine,
	createWakeOutbox,
	type HandWakeLink,
	type WakeLimits,
	type WakeOutbox,
} from "@earendil-works/pi-agent-core";
import { claimStateStore, openStateFileStore } from "../rpc/state-file-store.ts";
import type { HandWakes } from "../rpc/remote-executor-scope.ts";

/**
 * How many un-acked wakes a hand keeps while its brain is away (senpi#6767 review M1): per scope, as the loop-hook hold
 * it replaces kept per session, and in total across the hand's scopes. Past a bound a wake the brain refused for good is
 * evicted (reported `refused`), or else the new wake is refused before it is sent (reported `overflow`); a wake already
 * sent is never evicted.
 */
export const HAND_WAKE_LIMITS: WakeLimits = { perScope: 256, total: 1024 };

export interface HandWakeOutboxOptions {
	readonly clock?: () => number;
	readonly limits?: WakeLimits;
	/** A pending entry the outbox could not read; it is dropped and reported to the brain. */
	readonly onFault?: (error: Error) => void;
}

/**
 * The hand's wake outbox on its state file: this process claims the file's next owner epoch, so a hand that opened it
 * earlier is refused from then on. Every event id it mints starts with `hand:`.
 */
export async function openHandWakeOutbox(path: string, options: HandWakeOutboxOptions = {}): Promise<WakeOutbox> {
	const store = openStateFileStore(path);
	const epoch = await claimStateStore(store);
	return createWakeOutbox({
		hand: "hand",
		store,
		epoch,
		admission: createAdmissionLine(),
		clock: options.clock ?? Date.now,
		limits: options.limits ?? HAND_WAKE_LIMITS,
		...(options.onFault === undefined ? {} : { onFault: options.onFault }),
	});
}

/** A hand's scopes' wakes over its wake link; the link reports every failure itself, so nothing here throws. */
export function handWakesOver(link: HandWakeLink): HandWakes {
	return {
		offer: (scope, wake) => void link.offer({ scope, ...wake }),
		closeScope: (scope) => void link.closeScope(scope),
	};
}
