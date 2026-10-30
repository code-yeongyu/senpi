import type { ProviderAccountFailoverEvent } from "../../core/extensions/builtin/anthropic-subscription/account-events.ts";

const ACCOUNT_FAILOVER_REASONS: Partial<Record<ProviderAccountFailoverEvent["reason"], string>> = {
	auth_error: "its login expired or was refused",
	rate_limit: "it hit a rate or usage limit",
	billing: "its account is out of credit",
	overloaded: "it was overloaded",
};

export function formatAccountFailoverNotice(event: ProviderAccountFailoverEvent): string {
	const why = ACCOUNT_FAILOVER_REASONS[event.reason] ?? "it failed";
	return `Switched ${event.provider} account ${event.from} -> ${event.to}: ${why}.`;
}
