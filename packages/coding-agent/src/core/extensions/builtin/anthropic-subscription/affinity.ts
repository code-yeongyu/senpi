import { createHash } from "node:crypto";
import { applyAccountOrder } from "@earendil-works/pi-ai/auth/pool/select";
import { activeModelBlockUntil, pruneModelBlocks } from "../../../credential-pool/model-scope.ts";
import type { AccountSlot } from "./accounts.ts";

export const DEFAULT_AFFINITY_KEY = "claude-sdk-oauth-default";

export type AffinityOptions = {
	affinityKey?: string;
	sessionId?: string;
	pinnedAccount?: string;
	/** Where `pinnedAccount` came from, so guidance for an unusable pin says where to change it. */
	pinSource?: PinSource;
	/**
	 * The account this session's SDK transcript lives under. It is kept while it can serve, so the
	 * session does not move accounts and re-send its whole conversation (senpi#2891).
	 */
	preferredAccount?: string;
	/** When false, a blocked pin, resident account, or HRW winner is never skipped. */
	readonly accountFallback?: boolean;
	/** The user's account order (senpi#3591): tried after the pin and the session's own account, before HRW. */
	accountOrder?: readonly string[];
	now?: number;
	/** The requested model; an account blocked only for another model stays eligible for it. */
	model?: string;
};

/**
 * The one account a request may use when account fallback is off (senpi#3465): its name, and whether it
 * is still configured. A pin or a session's resident account can name an account that was later removed.
 */
export type UnavailableAccount = {
	readonly name: string;
	readonly configured: boolean;
	/** Set when the account is a pin: a CLI or settings pin outranks `/claude-account pin`, so that advice would do nothing. */
	readonly pinnedBy?: PinSource;
};

/** The origin of an account pin, highest precedence first (`resolveClaudeAccountPin`). */
export type PinSource = "cli" | "settings" | "stored";

export class AllAccountsBlockedError extends Error {
	readonly soonestUnblockAt: number | undefined;
	/**
	 * Set only when EVERY candidate is auth-blocked, so the guidance asks for a
	 * re-login (omo#8383). A pool where any account waits on a deadline (a rate
	 * limit, a usage reset, a model limit) recovers on its own at
	 * `soonestUnblockAt`, and calling it an auth failure made that temporary
	 * block look permanent (senpi#2081).
	 */
	readonly blockReason: "auth_error" | undefined;
	/**
	 * The requested model when a usage limit on that model, not the accounts, is
	 * what blocks it somewhere: the message then names the model, so the fallback
	 * chain moves only this model and keeps the provider for the others.
	 */
	readonly limitedModel: string | undefined;
	/** Set only when account fallback is off, so the guidance names that account instead of the whole pool. */
	readonly unavailableAccount: UnavailableAccount | undefined;

	constructor(
		soonestUnblockAt: number | undefined,
		blockReason?: "auth_error",
		limitedModel?: string,
		unavailableAccount?: UnavailableAccount,
	) {
		const until = soonestUnblockAt === undefined ? undefined : new Date(soonestUnblockAt).toISOString();
		super(
			limitedModel !== undefined && until !== undefined
				? `All Anthropic Subscription accounts have hit the usage limit for model ${limitedModel} until ${until}.`
				: until === undefined
					? "All Anthropic Subscription accounts are blocked until re-login."
					: `All Anthropic Subscription accounts are blocked until ${until}.`,
		);
		this.limitedModel = limitedModel;
		this.name = "AllAccountsBlockedError";
		this.soonestUnblockAt = soonestUnblockAt;
		this.blockReason = blockReason;
		this.unavailableAccount = unavailableAccount;
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

/** Account-level block for selection; an auth block with no deadline or a passed one is re-probed (senpi#3264). */
export function isAccountBlocked(account: Pick<AccountSlot, "blockedUntil">, now: number): boolean {
	return account.blockedUntil !== undefined && account.blockedUntil > now;
}

/** Whether the account can serve `model` now: no account-level block and no live block on that model. */
export function isBlockedFor(account: AccountSlot, now: number, model?: string): boolean {
	return isAccountBlocked(account, now) || activeModelBlockUntil(account.modelBlocks, model, now) !== undefined;
}

/**
 * Removes elapsed blocks, auth blocks included: an auth block lasts until its
 * re-probe time (senpi#3264), and one persisted before re-probe times existed
 * has no expiry and clears at once, so the next request probes the account.
 */
export function clearExpiredBlocks(accounts: readonly AccountSlot[], now = Date.now()): AccountSlot[] {
	return accounts.map((account) => {
		let available = account;
		if (account.blockReason !== undefined && (account.blockedUntil === undefined || account.blockedUntil <= now)) {
			const { blockedUntil: _blockedUntil, blockReason: _blockReason, blockedAt: _blockedAt, ...rest } = account;
			available = rest;
		}
		if (available.modelBlocks === undefined) return available;
		const { modelBlocks, ...rest } = available;
		const live = pruneModelBlocks(modelBlocks, now);
		return live === undefined ? rest : { ...rest, modelBlocks: live };
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
	if (pinned && !isBlockedFor(pinned, now, options.model)) return pinned;
	const preferred =
		options.preferredAccount === undefined
			? undefined
			: accounts.find((account) => account.name === options.preferredAccount);
	if (preferred && !isBlockedFor(preferred, now, options.model)) return preferred;
	return applyAccountOrder(options.accountOrder, rendezvousOrder(getAffinityKey(options), accounts)).find(
		(account) => !isBlockedFor(account, now, options.model),
	);
}

function unblockAt(account: AccountSlot, now: number, model: string | undefined): number | undefined {
	const accountUntil =
		account.blockedUntil !== undefined && account.blockedUntil > now ? account.blockedUntil : undefined;
	const modelUntil = activeModelBlockUntil(account.modelBlocks, model, now);
	if (accountUntil === undefined) return modelUntil;
	return modelUntil === undefined ? accountUntil : Math.max(accountUntil, modelUntil);
}

function soonestUnblockAt(
	accounts: readonly AccountSlot[],
	now: number,
	model: string | undefined,
): number | undefined {
	const candidates = accounts
		.map((account) => unblockAt(account, now, model))
		.filter((value): value is number => value !== undefined);
	return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function limitedModel(accounts: readonly AccountSlot[], now: number, model: string | undefined): string | undefined {
	const modelOnly = accounts.some(
		(account) =>
			!isAccountBlocked(account, now) && activeModelBlockUntil(account.modelBlocks, model, now) !== undefined,
	);
	return modelOnly ? model : undefined;
}

/** Selects a pinned or HRW-ranked account with no provider-global selection state. */
export function selectAccount(accounts: readonly AccountSlot[], options: AffinityOptions = {}): AccountSlot {
	const now = options.now ?? Date.now();
	let candidates = accounts;
	let unavailableAccount: UnavailableAccount | undefined;
	if (options.accountFallback === false) {
		const name =
			options.pinnedAccount ??
			options.preferredAccount ??
			applyAccountOrder(options.accountOrder, rendezvousOrder(getAffinityKey(options), accounts))[0]?.name;
		candidates = accounts.filter((account) => account.name === name);
		const pinnedBy = options.pinnedAccount !== undefined ? options.pinSource : undefined;
		if (name !== undefined)
			unavailableAccount = {
				name,
				configured: candidates.length > 0,
				...(pinnedBy === undefined ? {} : { pinnedBy }),
			};
	}
	const selected = selectUnblocked(candidates, options, now);
	if (selected) return selected;

	// A stale persisted rate-limit entry must not dead-end the pool. Retry once
	// against the cleared view before reporting the earliest available account.
	const cleared = clearExpiredBlocks(candidates, now);
	const afterClear = selectUnblocked(cleared, options, now);
	if (afterClear) return afterClear;
	throw new AllAccountsBlockedError(
		soonestUnblockAt(candidates, now, options.model),
		candidates.length > 0 && candidates.every((account) => account.blockReason === "auth_error")
			? "auth_error"
			: undefined,
		limitedModel(candidates, now, options.model),
		unavailableAccount,
	);
}
