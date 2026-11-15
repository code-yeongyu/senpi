import { subscriptionLimits } from "../../../subscription-limits/limit-store.ts";
import type { ExtensionAPI, InputEvent } from "../../types.ts";
import type { AccountSlot } from "./accounts.ts";

/**
 * One allowance per account on an admitted person's turn (senpi#6727). Input attribution is already classified
 * by the session, including RPC's interactive-user role. Retries retain the same set; automation cannot mint one.
 */
export function registerLimitRecheck(pi: ExtensionAPI): {
	readonly accounts: () => Set<string> | undefined;
	readonly reset: () => void;
} {
	const pending = new Map<string, Pick<InputEvent, "attribution" | "streamingBehavior">>();
	let attempted: Set<string> | undefined;
	let running = false;
	const reset = () => {
		pending.clear();
		attempted = undefined;
		running = false;
	};
	pi.on("input", (event) => {
		pending.set(event.inputId, { attribution: event.attribution, streamingBehavior: event.streamingBehavior });
	});
	pi.on("input_disposition", (event) => {
		if (event.disposition === "queued") return;
		const input = pending.get(event.inputId);
		pending.delete(event.inputId);
		if (event.disposition !== "started" || input === undefined) return;
		// Steering joins an existing turn; it cannot refill that turn's allowance.
		if (input.streamingBehavior === "steer" && running) return;
		attempted = input.attribution === "user" ? new Set() : undefined;
	});
	pi.on("agent_start", () => {
		running = true;
	});
	pi.on("agent_end", (event) => {
		if (!event.willRetry) {
			attempted = undefined;
			running = false;
		}
	});
	pi.on("session_start", reset);
	return { accounts: () => attempted, reset };
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
