import type { Credential } from "@earendil-works/pi-ai";
import { fetchAnthropicModelIds } from "@earendil-works/pi-ai/providers/anthropic-listed-models";
import { getAgentDir } from "../../../../config.ts";
import { claudeAccounts } from "../../../subscription-limits/usage-accounts.ts";

const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Every model id the lane's Claude accounts list (`GET /v1/models` with each account's subscription token), so a
 * release Anthropic offers only to approved organizations shows when one of the accounts has it. Undefined when no
 * account offers a token right now; throws when every account that asked failed, so the last listing stays.
 */
export async function listAccountModelIds(
	credential: Credential | undefined,
	signal: AbortSignal,
): Promise<string[] | undefined> {
	const accounts = claudeAccounts(credential, {
		env: (name) => process.env[name],
		now: Date.now,
		agentDir: getAgentDir(),
	});
	const tokens = (await Promise.all(accounts.map((account) => account.access(signal)))).flatMap((result) =>
		result !== undefined && "access" in result ? [result.access] : [],
	);
	if (tokens.length === 0) return undefined;
	const listings = await Promise.allSettled(
		tokens.map((token) =>
			fetchAnthropicModelIds({ authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA }, signal),
		),
	);
	const listed = listings.flatMap((listing) => (listing.status === "fulfilled" ? [listing.value] : []));
	if (listed.length === 0) throw (listings[0] as PromiseRejectedResult).reason;
	return [...new Set(listed.flat())];
}
