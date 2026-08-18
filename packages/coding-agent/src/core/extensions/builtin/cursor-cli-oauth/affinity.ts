import { createHash } from "node:crypto";

export const DEFAULT_CURSOR_AFFINITY_KEY = "cursor-cli-oauth-default";

export type CursorAffinityAccountSlot = {
	name: string;
	blockedUntil?: number;
	blockReason?: string;
};

export type CursorAffinityOptions = {
	affinityKey?: string;
	sessionId?: string;
	pinnedAccount?: string;
	now?: number;
};

export class AllCursorAccountsBlockedError extends Error {
	readonly soonestUnblockAt: number | undefined;

	constructor(soonestUnblockAt: number | undefined) {
		super(
			soonestUnblockAt === undefined
				? "All Cursor CLI OAuth accounts are blocked until re-login."
				: `All Cursor CLI OAuth accounts are blocked until ${new Date(soonestUnblockAt).toISOString()}.`,
		);
		this.name = "AllCursorAccountsBlockedError";
		this.soonestUnblockAt = soonestUnblockAt;
	}
}

export function getAffinityKey(options: Pick<CursorAffinityOptions, "affinityKey" | "sessionId">): string {
	return options.affinityKey ?? options.sessionId ?? DEFAULT_CURSOR_AFFINITY_KEY;
}

function score(key: string, accountName: string): bigint {
	return createHash("sha256").update(`${key}\0${accountName}`).digest().readBigUInt64BE(0);
}

/** Orders accounts by descending highest-random-weight score for the session key. */
export function rendezvousOrder<T extends CursorAffinityAccountSlot>(key: string, accounts: readonly T[]): T[] {
	return [...accounts]
		.map((account) => ({ account, score: score(key, account.name) }))
		.sort((left, right) => (right.score > left.score ? 1 : right.score < left.score ? -1 : 0))
		.map(({ account }) => account);
}

function isBlocked(account: CursorAffinityAccountSlot, now: number): boolean {
	return account.blockReason === "auth_error" || (account.blockedUntil !== undefined && account.blockedUntil > now);
}

/** Clears elapsed temporary blocks while retaining auth failures until the account logs in again. */
export function clearExpiredBlocks<T extends CursorAffinityAccountSlot>(accounts: readonly T[], now = Date.now()): T[] {
	return accounts.map((account) => {
		if (account.blockReason !== "auth_error" && account.blockedUntil !== undefined && account.blockedUntil <= now) {
			const { blockedUntil: _blockedUntil, blockReason: _blockReason, ...available } = account;
			return available as T;
		}
		return account;
	});
}

function selectUnblocked<T extends CursorAffinityAccountSlot>(
	accounts: readonly T[],
	options: CursorAffinityOptions,
	now: number,
): T | undefined {
	const pinned =
		options.pinnedAccount === undefined
			? undefined
			: accounts.find((account) => account.name === options.pinnedAccount);
	if (pinned && !isBlocked(pinned, now)) return pinned;
	return rendezvousOrder(getAffinityKey(options), accounts).find((account) => !isBlocked(account, now));
}

function soonestUnblockAt(accounts: readonly CursorAffinityAccountSlot[], now: number): number | undefined {
	const candidates = accounts
		.map((account) => account.blockedUntil)
		.filter((value): value is number => value !== undefined && value > now);
	return candidates.length === 0 ? undefined : Math.min(...candidates);
}

/** Selects the pinned account or the first available account in session-stable HRW order. */
export function selectAccount<T extends CursorAffinityAccountSlot>(
	accounts: readonly T[],
	options: CursorAffinityOptions = {},
): T {
	const now = options.now ?? Date.now();
	const selected = selectUnblocked(accounts, options, now);
	if (selected) return selected;

	const cleared = clearExpiredBlocks(accounts, now);
	const afterClear = selectUnblocked(cleared, options, now);
	if (afterClear) return afterClear;
	throw new AllCursorAccountsBlockedError(soonestUnblockAt(accounts, now));
}
