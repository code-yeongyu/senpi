import { seatDigest } from "./seat-digest.ts";
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
 * refuses a request locally has a recorded cause (senpi#4671). The account is named by its seat digest,
 * never its name (Desktop#4753); an unknown end time is left out rather than guessed.
 */
export function logAccountBlocked(record: AccountBlockRecord): void {
	logContinuityEvent("account_blocked", {
		seat: seatDigest(record.account),
		reason: record.reason,
		...(record.until === undefined ? {} : { until: new Date(record.until).toISOString() }),
		shared: record.shared,
		error: record.detail.slice(0, MAX_DETAIL_CHARS),
	});
}
