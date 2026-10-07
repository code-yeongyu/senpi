export type SlotHasher = (input: string) => bigint;

export type SelectableSlot = {
	name: string;
	blockedUntil?: number;
	blockReason?: string;
};

export const DEFAULT_POOL_AFFINITY_KEY = "credential-pool-default";

export class AllSlotsBlockedError extends Error {
	readonly soonestUnblockAt: number | undefined;

	constructor(soonestUnblockAt: number | undefined) {
		super(
			soonestUnblockAt === undefined
				? "All credential slots are blocked until re-login."
				: `All credential slots are blocked until ${new Date(soonestUnblockAt).toISOString()}.`,
		);
		this.name = "AllSlotsBlockedError";
		this.soonestUnblockAt = soonestUnblockAt;
	}
}

export type SlotSelectionOptions = {
	/** Injected so this module stays browser-safe; callers pick the hash (sha256 for oracle parity). */
	hasher: SlotHasher;
	affinityKey?: string;
	sessionId?: string;
	pinnedSlot?: string;
	now?: number;
};

export function getPoolAffinityKey(options: Pick<SlotSelectionOptions, "affinityKey" | "sessionId">): string {
	return options.affinityKey ?? options.sessionId ?? DEFAULT_POOL_AFFINITY_KEY;
}

/**
 * HRW ordering hashes `key\0slot.name` exactly like the claude-sdk-oauth
 * affinity oracle, so a sha256 hasher reproduces its winner sequence and no
 * live session remaps when a pool migrates onto this engine.
 */
export function rendezvousOrder<T extends SelectableSlot>(key: string, slots: readonly T[], hasher: SlotHasher): T[] {
	return [...slots]
		.map((slot) => ({ slot, score: hasher(`${key}\0${slot.name}`) }))
		.sort((left, right) => (right.score > left.score ? 1 : right.score < left.score ? -1 : 0))
		.map(({ slot }) => slot);
}

function isBlocked(slot: SelectableSlot, now: number): boolean {
	return slot.blockReason === "auth_error" || (slot.blockedUntil !== undefined && slot.blockedUntil > now);
}

/** Elapsed rate/capacity blocks clear; auth blocks persist until a login rewrites the slot. */
export function clearExpiredSlotBlocks(slots: readonly SelectableSlot[], now = Date.now()): SelectableSlot[] {
	return slots.map((slot) => {
		if (slot.blockReason !== "auth_error" && slot.blockedUntil !== undefined && slot.blockedUntil <= now) {
			const { blockedUntil: _blockedUntil, blockReason: _blockReason, ...available } = slot;
			return available;
		}
		return slot;
	});
}

function selectUnblocked<T extends SelectableSlot>(
	slots: readonly T[],
	options: SlotSelectionOptions,
	now: number,
): T | undefined {
	const pinned = options.pinnedSlot === undefined ? undefined : slots.find((slot) => slot.name === options.pinnedSlot);
	if (pinned && !isBlocked(pinned, now)) return pinned;
	return rendezvousOrder(getPoolAffinityKey(options), slots, options.hasher).find((slot) => !isBlocked(slot, now));
}

function soonestUnblockAt(slots: readonly SelectableSlot[], now: number): number | undefined {
	const candidates = slots
		.map((slot) => slot.blockedUntil)
		.filter((value): value is number => value !== undefined && value > now);
	return candidates.length === 0 ? undefined : Math.min(...candidates);
}

/** Selects a pinned or HRW-ranked slot with no pool-global selection state. */
export function selectSlot<T extends SelectableSlot>(slots: readonly T[], options: SlotSelectionOptions): T {
	const now = options.now ?? Date.now();
	const selected = selectUnblocked(slots, options, now);
	if (selected) return selected;

	// A stale persisted rate-limit entry must not dead-end the pool: retry once
	// against the cleared view, then map the winner back to the caller's slot.
	const cleared = clearExpiredSlotBlocks(slots, now);
	const retried = selectUnblocked(cleared, { ...options, now }, now);
	const original = retried === undefined ? undefined : slots.find((slot) => slot.name === retried.name);
	if (original) return original;
	throw new AllSlotsBlockedError(soonestUnblockAt(slots, now));
}
