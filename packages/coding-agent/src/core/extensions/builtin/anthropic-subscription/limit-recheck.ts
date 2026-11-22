import { subscriptionLimits } from "../../../subscription-limits/limit-store.ts";
import { currentPersonTurn } from "../../../turn-origin.ts";
import type { ExtensionAPI } from "../../types.ts";
import type { AccountSlot } from "./accounts.ts";

/**
 * One allowance per account on an admitted person's turn (senpi#6727). Its identity follows the actual message,
 * not a predicted end event: a fresh run drops it even when the previous retry was cancelled or blocked.
 */
export function registerLimitRecheck(pi: ExtensionAPI): {
	readonly accounts: () => Set<string> | undefined;
	readonly reset: () => void;
} {
	let sessionManager: object | undefined;
	let turn: object | undefined;
	let attempted: Set<string> | undefined;
	const reset = () => {
		sessionManager = undefined;
		turn = undefined;
		attempted = undefined;
	};
	pi.on("agent_start", (_event, ctx) => {
		sessionManager = ctx.sessionManager;
	});
	pi.on("session_start", reset);
	return {
		accounts: () => {
			const activeTurn = sessionManager === undefined ? undefined : currentPersonTurn(sessionManager);
			if (activeTurn !== turn) {
				turn = activeTurn;
				attempted = turn === undefined ? undefined : new Set();
			}
			return attempted;
		},
		reset,
	};
}

/** A rate-limit block with no successful usage reading newer than the block. Errors are not usage evidence. */
export function unverifiedLimitBlock(account: AccountSlot, now: number): boolean {
	if (account.blockReason !== "rate_limit" || (account.blockedUntil ?? 0) <= now) return false;
	const limits = subscriptionLimits
		.snapshot()
		.find((entry) => entry.provider === "anthropic-subscription" && entry.account === account.name);
	return (
		account.blockedAt === undefined ||
		limits === undefined ||
		limits.windows.length === 0 ||
		Date.parse(limits.reportedAt) <= account.blockedAt
	);
}

/** The selection view alone is opened. Persistent state and model-specific blocks remain authoritative. */
export function recheckSelection(
	accounts: readonly AccountSlot[],
	attempted: ReadonlySet<string> | undefined,
	now: number,
): readonly AccountSlot[] {
	if (attempted === undefined) return accounts;
	return accounts.map((account) => {
		if (attempted.has(account.name) || !unverifiedLimitBlock(account, now)) return account;
		const { blockReason: _reason, blockedUntil: _until, blockedAt: _at, ...available } = account;
		return available;
	});
}
