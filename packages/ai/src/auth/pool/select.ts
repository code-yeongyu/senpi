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
		// Local time for the reader, the ISO instant for prose scanners, and one step (senpi#4329).
		super(
			soonestUnblockAt === undefined
				? "All credential slots are blocked until re-login. Sign in again or add a new API key for this provider, or choose another model."
				: `All credential slots are blocked until ${new Date(soonestUnblockAt).toLocaleString("en-US", {
						year: "numeric",
						month: "short",
						day: "numeric",
						hour: "numeric",
						minute: "2-digit",
						timeZoneName: "short",
					})} (${new Date(soonestUnblockAt).toISOString()}). Wait until then, or choose another model.`,
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

/**
 * Moves the accounts a user order names to the front, in that order; the rest keep
 * their ranked order behind them. Names missing from `ranked` are skipped, so a
 * stale order (a removed account) never blocks selection.
 */
export function applyAccountOrder<T extends { readonly name: string }>(
	order: readonly string[] | undefined,
	ranked: readonly T[],
): T[] {
	if (order === undefined || order.length === 0) return [...ranked];
	const byName = new Map(ranked.map((slot) => [slot.name, slot]));
	const front: T[] = [];
	for (const name of order) {
		const slot = byName.get(name);
		if (slot !== undefined && !front.includes(slot)) front.push(slot);
	}
	return [...front, ...ranked.filter((slot) => !front.includes(slot))];
}

/** Drops a removed account from a stored user order, and the order itself once it is empty. */
export function withoutOrderedAccount<T extends { order?: string[] }>(credential: T, name: string): T {
	if (credential.order === undefined || !credential.order.includes(name)) return credential;
	const order = credential.order.filter((entry) => entry !== name);
	const next = { ...credential };
	if (order.length === 0) delete next.order;
	else next.order = order;
	return next;
}

/**
 * Whether selection skips a slot now: an auth block holds until a login rewrites the slot, whatever its deadline;
 * any other block holds until its deadline. Account listings ask this too, so they never call a skipped slot available.
 */
export function isSlotBlocked(slot: Pick<SelectableSlot, "blockedUntil" | "blockReason">, now: number): boolean {
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
	if (pinned && !isSlotBlocked(pinned, now)) return pinned;
	return rendezvousOrder(getPoolAffinityKey(options), slots, options.hasher).find((slot) => !isSlotBlocked(slot, now));
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
