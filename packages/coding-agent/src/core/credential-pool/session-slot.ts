import { applyAccountOrder, rendezvousOrder, type SlotHasher } from "@earendil-works/pi-ai/auth/pool/select";
import { isAvailable } from "./failover.ts";
import type { RotationSlot } from "./rotation-slots.ts";

export type SlotPickPolicy = {
	affinityKey: string;
	useAffinity: boolean;
	hasher: SlotHasher;
	/** The pool's user account order, applied after the pin (senpi#3591). */
	order?: readonly string[];
};

/** The pin when present, else the first account of the affinity order with the user's order applied. */
export function pickRotationSlot<TSlot extends RotationSlot>(
	candidates: readonly TSlot[],
	policy: SlotPickPolicy,
): TSlot | undefined {
	const pinned = candidates.find((candidate) => candidate.pinned === true);
	if (pinned) return pinned;
	const ranked = policy.useAffinity ? rendezvousOrder(policy.affinityKey, candidates, policy.hasher) : candidates;
	return applyAccountOrder(policy.order, ranked)[0];
}

/**
 * The account a session's next streamed request starts on, for callers that send a resolved key
 * outside the rotation stream (compaction, /btw, look-at, cache keepalive). It is the stream's own
 * pick over the accounts the pool has not blocked; when every account is blocked the same pick runs
 * over all of them, so the caller reports that account's failure instead of using another account.
 */
export function selectSessionSlot(
	slots: readonly RotationSlot[],
	policy: SlotPickPolicy,
	now: number,
): RotationSlot | undefined {
	const available = slots.filter((slot) => isAvailable(slot, now));
	return pickRotationSlot(available.length > 0 ? available : slots, policy);
}
