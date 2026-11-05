import { formatAccountRetryTime } from "../credential-account-status.ts";
import { type AccountLimits, type SubscriptionLimitStore, subscriptionLimits } from "./limit-store.ts";

function age(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/**
 * One account's limit windows for an account list (oh-my-openagent#9234): the share used and when each window
 * resets, plus how old the reading is. A window whose reset has passed since the reading says so instead of
 * repeating a stale share; an account nothing has reported for says so instead of showing 0%.
 */
export function describeAccountLimits(limits: AccountLimits | undefined, now: number): string {
	if (limits === undefined) return "limits: not reported yet";
	if (limits.windows.length === 0) {
		return limits.error === undefined ? "limits: not reported yet" : `limits: last check failed: ${limits.error}`;
	}
	const windows = limits.windows.map((window) => {
		const resetsAt = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt);
		if (resetsAt !== undefined && resetsAt <= now) return `${window.label} reset since this reading`;
		const used = `${window.label} ${Math.round(window.usedPercent)}% used`;
		return resetsAt === undefined ? used : `${used}, resets ${formatAccountRetryTime(resetsAt)}`;
	});
	const reading = `updated ${age(now - Date.parse(limits.reportedAt))}`;
	const failed = limits.error === undefined ? "" : `; last check failed: ${limits.error}`;
	return `limits: ${windows.join("; ")} (${reading}${failed})`;
}

/** The latest limits the process holds for one provider account. */
export function accountLimitsFor(
	provider: string,
	account: string,
	store: SubscriptionLimitStore = subscriptionLimits,
): AccountLimits | undefined {
	return store.snapshot().find((limits) => limits.provider === provider && limits.account === account);
}
