import { logContinuityEvent } from "./session-observability.ts";

const MAX_DETAIL_CHARS = 200;

export type AccountBlockRecord = {
	readonly account: string;
	readonly reason: string;
	readonly until: number | undefined;
	/** Whether the block was written to the credential store for every session, or held for this session only. */
	readonly shared: boolean;
	readonly detail: string;
};

/**
 * Writes one `account_blocked` line to session.log for every block that is saved, so a pool that later
 * refuses a request locally has a recorded cause (senpi#4671).
 */
export function logAccountBlocked(record: AccountBlockRecord): void {
	logContinuityEvent("account_blocked", {
		account: record.account,
		reason: record.reason,
		until: record.until === undefined ? "re-login" : new Date(record.until).toISOString(),
		shared: record.shared,
		detail: record.detail.slice(0, MAX_DETAIL_CHARS),
	});
}
