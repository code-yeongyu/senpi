import type { CredentialAccountSummary } from "../../credential-accounts.ts";
import type { AccountLimits } from "../../subscription-limits/limit-store.ts";
import { readingAge } from "../../subscription-limits/limit-summary.ts";

/**
 * One account block of a TUI account list (senpi#6288): a header line with the label and short tags, then aligned
 * `label  value` rows for status and each limit window. Plain text, because RPC clients receive the same notice.
 */
export interface AccountListEntry {
	readonly label: string;
	readonly tags: readonly string[];
	/** One phrase per reason the account sits out, or `available`. */
	readonly status: readonly string[];
	readonly limits: AccountLimits | undefined;
}

type AccountBlock = Pick<CredentialAccountSummary, "blocked" | "blockedReason" | "blockedUntil">;
type Row = readonly [label: string, value: string];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function relative(ms: number): string {
	const minutes = Math.ceil(ms / MINUTE);
	if (minutes < 1) return "now";
	if (minutes < 60) return `in ${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 === 0 ? `in ${hours} h` : `in ${hours} h ${minutes % 60} min`;
	const days = Math.floor(hours / 24);
	return hours % 24 === 0 ? `in ${days} d` : `in ${days} d ${hours % 24} h`;
}

/** Local clock time; ICU's narrow no-break space before AM/PM renders unevenly in terminals. */
function clock(epochMs: number, now: number): string {
	const at = new Date(epochMs);
	const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
	if (at.toDateString() === new Date(now).toDateString()) return time.replace(/\u202f/g, " ");
	const day =
		epochMs - now < 6 * DAY
			? at.toLocaleDateString("en-US", { weekday: "short" })
			: `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })},`;
	return `${day} ${time}`.replace(/\u202f/g, " ");
}

/** "in 3 h (10:44 PM)": how long first, then the local clock time without year or time zone. */
export function formatWhen(epochMs: number, now: number): string {
	return `${relative(epochMs - now)} (${clock(epochMs, now)})`;
}

/** An account-level block in list wording; the reasons match `describeAccountBlock` (senpi#4092). */
export function describeBlockStatus(block: AccountBlock, now: number): string {
	if (!block.blocked) return "available";
	const when = block.blockedUntil === undefined ? undefined : formatWhen(block.blockedUntil, now);
	switch (block.blockedReason) {
		case "disabled":
			return "account disabled; needs attention";
		case "auth_error":
			return when === undefined ? "sign-in rejected; sign in again" : `sign-in rejected, next check ${when}`;
		case "rate_limit":
			return when === undefined ? "rate limited" : `rate limited, retry ${when}`;
		case undefined:
			return when === undefined ? "blocked; reason and retry time unavailable" : `blocked, retry ${when}`;
	}
}

function limitRows(limits: AccountLimits | undefined, now: number): Row[] {
	if (limits === undefined) return [["limits", "not reported yet"]];
	if (limits.windows.length === 0) {
		return [["limits", limits.error === undefined ? "not reported yet" : `last check failed: ${limits.error}`]];
	}
	const rows: Row[] = limits.windows.map((window) => {
		const resetsAt = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt);
		if (resetsAt !== undefined && resetsAt <= now) return [window.label, "reset since this reading"];
		const used = `${`${Math.round(window.usedPercent)}%`.padStart(4)} used`;
		return [window.label, resetsAt === undefined ? used : `${used}, resets ${formatWhen(resetsAt, now)}`];
	});
	const failed = limits.error === undefined ? "" : `; last check failed: ${limits.error}`;
	rows.push(["updated", `${readingAge(now - Date.parse(limits.reportedAt))}${failed}`]);
	return rows;
}

/** The whole list: a counted title, one block per account, then footer lines after a blank line. */
export function renderAccountList(
	title: string,
	entries: readonly AccountListEntry[],
	footer: readonly string[],
	now: number,
): string {
	if (entries.length === 0) return [`${title}: none`, ...footer].join("\n");
	const blocks = entries.map((entry) => ({
		entry,
		rows: [
			...entry.status.map((status, index): Row => [index === 0 ? "status" : "", status]),
			...limitRows(entry.limits, now),
		],
	}));
	const width = Math.max(...blocks.flatMap(({ rows }) => rows.map(([label]) => label.length)));
	const lines = [`${title} (${entries.length})`];
	for (const { entry, rows } of blocks) {
		lines.push("", entry.tags.length === 0 ? entry.label : `${entry.label}  [${entry.tags.join(", ")}]`);
		for (const [label, value] of rows) lines.push(`  ${label.padEnd(width)}  ${value}`);
	}
	if (footer.length > 0) lines.push("", ...footer);
	return lines.join("\n");
}
