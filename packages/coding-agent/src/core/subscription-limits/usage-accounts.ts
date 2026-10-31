/**
 * The subscription accounts a usage poll can speak for, named exactly as turns name them in the store
 * (senpi#3684): a Claude account by its slot name, a ChatGPT account by its pool slot name (`default` for a
 * single login). The token is read only when a poll is actually due. A Claude account polls only with a
 * `CLAUDE_CODE_OAUTH_TOKEN` env token; a claude CLI account's token lives in the CLI's own store, and senpi
 * never refreshes a Claude token (senpi#4436). Tokens never leave this module's callers: they go into one
 * request header and nowhere else.
 */
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { listSlots, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import {
	type AnthropicSubscriptionCredential,
	emptyCredential,
	envSlotToken,
	isEnvSlot,
	listAccounts,
} from "../extensions/builtin/anthropic-subscription/accounts.ts";
import type { UsageProvider } from "./usage-endpoints.ts";

/** `undefined`: nothing usable to ask with right now (an expired ChatGPT token a turn will renew). */
export type AccessResult = { readonly access: string } | { readonly error: string } | undefined;

export interface PollAccount {
	readonly provider: UsageProvider;
	readonly account: string;
	access(signal: AbortSignal): Promise<AccessResult>;
}

export interface AccountSources {
	readonly store: CredentialStore;
	readonly env: (name: string) => string | undefined;
	readonly now: () => number;
}

export const SIGN_IN_NEEDED = "auth stale - run /login";

export async function listPollAccounts(sources: AccountSources): Promise<PollAccount[]> {
	const [claude, chatgpt] = await Promise.all([
		sources.store.read("anthropic-subscription"),
		sources.store.read("chatgpt-subscription"),
	]);
	return [...claudeAccounts(claude, sources), ...chatgptAccounts(chatgpt, sources.now)];
}

function claudeAccounts(stored: Credential | undefined, sources: AccountSources): PollAccount[] {
	const credential = stored?.type === "oauth" ? (stored as AnthropicSubscriptionCredential) : emptyCredential();
	return listAccounts(credential, sources.env)
		.filter(isEnvSlot)
		.map((slot) => ({
			provider: "anthropic-subscription",
			account: slot.name,
			async access() {
				const token = envSlotToken(sources.env, slot.name);
				return token === undefined ? undefined : { access: token };
			},
		}));
}

function chatgptAccounts(stored: Credential | undefined, now: () => number): PollAccount[] {
	if (stored?.type !== "oauth") return [];
	return listSlots(stored as PooledCredential).flatMap((slot) =>
		slot.access === undefined || slot.access === ""
			? []
			: [
					{
						provider: "chatgpt-subscription" as const,
						account: slot.name,
						async access() {
							return slot.expires !== undefined && now() >= slot.expires
								? undefined
								: { access: slot.access ?? "" };
						},
					},
				],
	);
}
