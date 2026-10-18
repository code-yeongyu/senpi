import type { Credential } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import {
	assertValidAccountName,
	type CredentialAccountSummary,
	credentialPoolRepository,
	getCredentialAccounts,
	summarizeCredentialAccounts,
} from "./credential-accounts.ts";
import type { CredentialSlotRepository } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/anthropic-subscription/account-events.ts";

/** A provider's accounts in effective order, and whether a user order shapes that order. */
export type CredentialAccountListing = {
	readonly accounts: CredentialAccountSummary[];
	readonly ordered: boolean;
};

function storedOrder(credential: PooledCredential | undefined): readonly string[] {
	return credential?.order ?? [];
}

export async function listCredentialAccounts(
	storage: AuthStorage,
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
	repository?: CredentialSlotRepository,
): Promise<CredentialAccountListing> {
	const accounts = await getCredentialAccounts(storage, provider, env, repository);
	const order = storedOrder(storage.get(provider));
	return { accounts, ordered: accounts.some((account) => order.includes(account.name)) };
}

function assertOrderNames(names: readonly string[], known: readonly CredentialAccountSummary[]): void {
	if (names.length === 0) throw new Error("Account order must name at least one account");
	const seen = new Set<string>();
	for (const name of names) {
		assertValidAccountName(name);
		if (seen.has(name)) throw new Error(`Duplicate provider account in order: ${name}`);
		seen.add(name);
		if (!known.some((account) => account.name === name)) throw new Error(`Provider account not found: ${name}`);
	}
}

function withOrder(credential: Credential, names: readonly string[] | null): PooledCredential {
	const { order: _previous, ...rest }: PooledCredential = credential;
	return names === null ? rest : { ...rest, order: [...names] };
}

/**
 * Sets the provider's account order, or clears it when `names` is null (senpi#3591).
 * The order lives beside the pin in the stored credential, so it has the pin's scope:
 * a provider with nothing stored has no order to keep.
 */
export async function orderCredentialAccounts(
	storage: AuthStorage,
	provider: string,
	names: readonly string[] | null,
	env: NodeJS.ProcessEnv = process.env,
	repository?: CredentialSlotRepository,
): Promise<void> {
	const repo = repository ?? credentialPoolRepository(storage);
	await storage.modify(provider, async (current) => {
		if (current === undefined) throw new Error(`No stored credential for provider: ${provider}`);
		// Validated against the credential this write replaces, under the store's lock,
		// so an account removed concurrently cannot leave its name in the order.
		if (names !== null) assertOrderNames(names, await summarizeCredentialAccounts(provider, current, env, repo));
		return withOrder(current, names);
	});
	emitProviderAccountsChanged(provider);
}
