import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import type { CredentialAccountSummary } from "./credential-accounts.ts";

type AccountBlock = Pick<CredentialAccountSummary, "blocked" | "blockedReason" | "blockedUntil">;

/** The local wall-clock time an account block lifts, in the reader's time zone. */
export function formatAccountRetryTime(epochMs: number): string {
	return new Date(epochMs).toLocaleString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
}

/**
 * One account's health in plain words: why it sits out and until when, the cases the desktop account row
 * shows (senpi#4092), so no account list says a bare "blocked".
 */
export function describeAccountBlock(block: AccountBlock): string {
	if (!block.blocked) return "available";
	const until = block.blockedUntil === undefined ? undefined : formatAccountRetryTime(block.blockedUntil);
	switch (block.blockedReason) {
		case "disabled":
			return "account disabled; needs attention";
		case "auth_error":
			return until === undefined ? "sign-in rejected; sign in again" : `sign-in rejected; next check after ${until}`;
		case "rate_limit":
			return until === undefined ? "rate limited" : `rate limited; retry after ${until}`;
		case undefined:
			return until === undefined ? "blocked; reason and retry time unavailable" : `blocked; retry after ${until}`;
	}
}

/** One `/account`-style list row: label, source, health, per-model limits and pin. Never key material. */
export function describeCredentialAccount(account: CredentialAccountSummary): string {
	const availability = account.unused
		? "unused (other login kind; switch with /login)"
		: describeAccountBlock(account);
	const states = [accountLabel(account), account.source, availability];
	for (const { model, until } of account.blockedModels ?? []) {
		states.push(`blocked for ${model} until ${formatAccountRetryTime(until)}`);
	}
	if (account.pinned) states.push("pinned");
	return states.join(" | ");
}
