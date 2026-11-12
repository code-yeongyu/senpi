/**
 * Whether usage the provider reported AFTER a limit hold began shows the account can serve again (senpi#6536).
 * A provider can lift a limit before the reset it stated (a usage reset the user redeemed); the stated reset is
 * then only a ceiling. Only a reading newer than the hold counts, every window it reports must be under its
 * limit (or already past its reset), and a reading with no windows or an error says nothing.
 */
import type { AccountLimits } from "./limit-store.ts";

export function usageShowsCapacity(limits: AccountLimits, since: number, now: number): boolean {
	if (limits.error !== undefined || limits.windows.length === 0) return false;
	if (Date.parse(limits.reportedAt) <= since) return false;
	return limits.windows.every((window) => {
		if (window.usedPercent < 100) return true;
		const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
		return Number.isFinite(resetsAt) && resetsAt <= now;
	});
}

/** The accounts of `provider` whose reported usage, newer than `since`, shows they can serve again. */
export function accountsWithCapacity(
	snapshot: readonly AccountLimits[],
	provider: string,
	since: number,
	now: number,
): string[] {
	return snapshot
		.filter((limits) => limits.provider === provider && usageShowsCapacity(limits, since, now))
		.map((limits) => limits.account);
}
