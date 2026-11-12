import { rendezvousOrder, type SlotHasher } from "@earendil-works/pi-ai/auth/pool/select";
import type { AccountLimits } from "../subscription-limits/limit-store.ts";
import { attemptCandidates, noSlotsError } from "./failover.ts";
import type { RotationSlot, RotationSources } from "./rotation-slots.ts";
import { type AccountStrategy, orderAccounts, preferHeadroom } from "./selection-order.ts";

/** Reported usage the pick prefers headroom from (omo#9234); a preference, never a block. */
type SlotHeadroom = {
	providerId: string;
	limits: readonly AccountLimits[];
	now: number;
	/** The account an earlier headroom skip, or a most-headroom pick, gave this session. */
	remembered?: string;
};

export type SlotPickPolicy = {
	affinityKey: string;
	useAffinity: boolean;
	hasher: SlotHasher;
	/** The pool's user account order, applied after the pin (senpi#3591). */
	order?: readonly string[];
	/** The configured account strategy (omo#10146); cache-affine when absent. */
	strategy?: AccountStrategy;
	/** This session's round-robin start, from roundRobinState. */
	roundRobinOffset?: number;
	headroom?: SlotHeadroom;
};

/** Only headroom-induced moves are remembered; ordinary HRW membership changes keep their existing behavior. */
const headroomAffinities = new WeakMap<RotationSources["repository"], Map<string, string>>();

/** The account a headroom skip moved this session to, so the stream and auxiliary requests read the same one. */
export function rememberedHeadroomAccount(
	repository: RotationSources["repository"],
	providerId: string,
	affinityKey: string,
): string | undefined {
	return headroomAffinities.get(repository)?.get(`${providerId}\0${affinityKey}`);
}

export function rememberHeadroomAccount(
	repository: RotationSources["repository"],
	providerId: string,
	affinityKey: string,
	account: string,
): void {
	const sessions = headroomAffinities.get(repository) ?? new Map<string, string>();
	sessions.set(`${providerId}\0${affinityKey}`, account);
	headroomAffinities.set(repository, sessions);
}

/** The strategy's order with the user's order applied, before the pin and before any headroom preference. */
export function orderRotationSlots<TSlot extends RotationSlot>(
	candidates: readonly TSlot[],
	policy: SlotPickPolicy,
): readonly TSlot[] {
	const ranked = policy.useAffinity ? rendezvousOrder(policy.affinityKey, candidates, policy.hasher) : candidates;
	const headroom = policy.headroom;
	return orderAccounts(
		candidates,
		ranked,
		policy.order,
		policy.strategy,
		policy.roundRobinOffset,
		headroom === undefined
			? undefined
			: { provider: headroom.providerId, limits: headroom.limits, now: headroom.now },
	);
}

/**
 * The pin when present, else the first account of the affinity order with the user's order applied,
 * preferring an account with headroom when the policy carries limit readings.
 */
export function pickRotationSlot<TSlot extends RotationSlot>(
	candidates: readonly TSlot[],
	policy: SlotPickPolicy,
): TSlot | undefined {
	const pinned = candidates.find((candidate) => candidate.pinned === true);
	if (pinned) return pinned;
	const ordered = orderRotationSlots(candidates, policy);
	const headroom = policy.headroom;
	if (!headroom) return ordered[0];
	return preferHeadroom(ordered, headroom.providerId, headroom.limits, headroom.now, headroom.remembered)[0];
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
