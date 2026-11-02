import { applyAccountOrder, rendezvousOrder, type SlotHasher } from "@earendil-works/pi-ai/auth/pool/select";
import { attemptCandidates, noSlotsError } from "./failover.ts";
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
 * first pick: the same candidates (unblocked accounts, else the rate-limited one due back first) and
 * the same order. When the stream would refuse, this throws the stream's refusal, so an auxiliary
 * request never authenticates as an account the stream would not use.
 */
export function selectSessionSlot<TSlot extends RotationSlot>(
	slots: readonly TSlot[],
	policy: SlotPickPolicy,
	now: number,
): TSlot | undefined {
	if (slots.length === 0) return undefined;
	const candidates = attemptCandidates(slots, new Set(), now);
	if (candidates.length === 0) throw noSlotsError(slots, now);
	return pickRotationSlot(candidates, policy);
}
