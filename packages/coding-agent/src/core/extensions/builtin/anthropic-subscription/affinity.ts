import { createHash } from "node:crypto";
import type { AccountSlot } from "./accounts.ts";

export const DEFAULT_AFFINITY_KEY = "claude-sdk-oauth-default";

export type AffinityOptions = {
	affinityKey?: string;
	sessionId?: string;
	pinnedAccount?: string;
	now?: number;
};

export class AllAccountsBlockedError extends Error {
	readonly soonestUnblockAt: number | undefined;
	/**
	 * Dominant block reason, set when at least one slot is auth-blocked, so the
	 * guidance and the outer credential-pool classifier read the cause instead
	 * of guessing it from prose (omo#8383).
	 */
	readonly blockReason: "auth_error" | undefined;

	constructor(soonestUnblockAt: number | undefined, blockReason?: "auth_error") {
		super(
			soonestUnblockAt === undefined
				? "All Anthropic Subscription accounts are blocked until re-login."
				: `All Anthropic Subscription accounts are blocked until ${new Date(soonestUnblockAt).toISOString()}.`,
		);
		this.name = "AllAccountsBlockedError";
		this.soonestUnblockAt = soonestUnblockAt;
		this.blockReason = blockReason;
	}
}

export function getAffinityKey(options: Pick<AffinityOptions, "affinityKey" | "sessionId">): string {
	return options.affinityKey ?? options.sessionId ?? DEFAULT_AFFINITY_KEY;
}

function score(key: string, accountName: string): bigint {
	return createHash("sha256").update(`${key}\0${accountName}`).digest().readBigUInt64BE(0);
}

/**
 * Session-stable HRW ordering preserves Claude prompt-cache locality while moving
 * only the sessions that rendezvous with a newly added or removed account.
 */
export function rendezvousOrder(key: string, accounts: readonly AccountSlot[]): AccountSlot[] {
	return [...accounts]
		.map((account) => ({ account, score: score(key, account.name) }))
		.sort((left, right) => (right.score > left.score ? 1 : right.score < left.score ? -1 : 0))
		.map(({ account }) => account);
}

function isBlocked(account: AccountSlot, now: number): boolean {
	return account.blockReason === "auth_error" || (account.blockedUntil !== undefined && account.blockedUntil > now);
}

/** Removes elapsed rate/capacity blocks but deliberately retains auth blocks until login refreshes the slot. */
export function clearExpiredBlocks(accounts: readonly AccountSlot[], now = Date.now()): AccountSlot[] {
	return accounts.map((account) => {
		if (account.blockReason !== "auth_error" && account.blockedUntil !== undefined && account.blockedUntil <= now) {
			const { blockedUntil: _blockedUntil, blockReason: _blockReason, ...available } = account;
			return available;
		}
		return account;
	});
}

function selectUnblocked(
	accounts: readonly AccountSlot[],
	options: AffinityOptions,
	now: number,
): AccountSlot | undefined {
	const pinned =
		options.pinnedAccount === undefined
			? undefined
			: accounts.find((account) => account.name === options.pinnedAccount);
	if (pinned && !isBlocked(pinned, now)) return pinned;
	return rendezvousOrder(getAffinityKey(options), accounts).find((account) => !isBlocked(account, now));
}

function soonestUnblockAt(accounts: readonly AccountSlot[], now: number): number | undefined {
	const candidates = accounts
		.map((account) => account.blockedUntil)
		.filter((value): value is number => value !== undefined && value > now);
	return candidates.length === 0 ? undefined : Math.min(...candidates);
}

/** Selects a pinned or HRW-ranked account with no provider-global selection state. */
export function selectAccount(accounts: readonly AccountSlot[], options: AffinityOptions = {}): AccountSlot {
	const now = options.now ?? Date.now();
	const selected = selectUnblocked(accounts, options, now);
	if (selected) return selected;

	// A stale persisted rate-limit entry must not dead-end the pool. Retry once
	// against the cleared view before reporting the earliest available account.
	const cleared = clearExpiredBlocks(accounts, now);
	const afterClear = selectUnblocked(cleared, options, now);
	if (afterClear) return afterClear;
	throw new AllAccountsBlockedError(
		soonestUnblockAt(accounts, now),
		accounts.some((account) => account.blockReason === "auth_error") ? "auth_error" : undefined,
	);
}
