import type { Credential } from "@earendil-works/pi-ai";
import { accountDisplayName } from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "../../../auth-storage.ts";
import { type RemoveCredentialAccountResult, removeCredentialAccount } from "../../../credential-accounts.ts";
import { emitProviderAccountsChanged } from "./account-events.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
	listAccounts,
	pinAccount,
} from "./accounts.ts";
import { forgetSessionBlocksFor } from "./failover.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./provider-id.ts";

export { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID };

export type ProviderAccountSummary = {
	readonly name: string;
	readonly displayName?: string;
	readonly source: AccountSlot["source"];
	readonly blocked: boolean;
	/** Same meaning as the generic account listing's fields (senpi#4327); present only while blocked. */
	readonly blockedReason?: "auth_error" | "rate_limit" | "disabled";
	readonly blockedUntil?: number;
	readonly pinned: boolean;
};

function timedBlock(
	account: Pick<AccountSlot, "blockedUntil" | "blockReason">,
	now: number,
): Pick<ProviderAccountSummary, "blocked" | "blockedReason" | "blockedUntil"> {
	const { blockedUntil, blockReason } = account;
	// Like the generic listing: a disabled account never lifts on its own and has no end time.
	if (blockReason === "account_disabled") return { blocked: true, blockedReason: "disabled" };
	if (blockedUntil === undefined || blockedUntil <= now) return { blocked: false };
	const blockedReason = blockReason === "auth_error" || blockReason === "rate_limit" ? blockReason : undefined;
	return { blocked: true, ...(blockedReason === undefined ? {} : { blockedReason }), blockedUntil };
}

export function getProviderAccounts(
	storage: AuthStorage,
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
): ProviderAccountSummary[] {
	assertManagedProvider(provider);
	const credential = credentialFrom(storage.get(provider));
	const now = Date.now();
	return listAccounts(credential, (name) => env[name]).map((account) => {
		const displayName = accountDisplayName(account.displayName);
		return {
			name: account.name,
			...(displayName === undefined ? {} : { displayName }),
			source: account.source,
			...timedBlock(account, now),
			pinned: credential.pinned === account.name,
		};
	});
}

export async function pinProviderAccount(
	storage: AuthStorage,
	provider: string,
	name: string | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	assertManagedProvider(provider);
	await storage.modify(provider, async (current) => {
		const credential = credentialFrom(current);
		if (name === null) {
			if (credential.pinned === undefined) return current;
			const { pinned: _pinned, ...unpinned } = credential;
			return unpinned;
		}
		if (!listAccounts(credential, (key) => env[key]).some((account) => account.name === name)) {
			throw new Error(`Provider account not found: ${name}`);
		}
		return pinAccount(credential, name);
	});
	emitProviderAccountsChanged(provider);
}

/**
 * `/claude-account remove` takes the same removal as RPC `account_remove` and `/account remove`, so the entry points
 * cannot diverge: a `claude-cli` slot is signed out of the CLI by its account dir, a linked dir is never followed,
 * and the slot is removed even when the sign-out cannot run, with a notice (senpi#4436).
 */
export async function removeProviderAccount(
	storage: AuthStorage,
	provider: string,
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<RemoveCredentialAccountResult> {
	assertManagedProvider(provider);
	return removeCredentialAccount(storage, provider, name, env);
}

/**
 * Lifts a usage or rate-limit block the user knows is wrong (extra usage bought, a misread reset).
 * Auth blocks stay: only a login or the re-probe can lift those. Returns whether a block was lifted.
 */
export async function unblockProviderAccount(
	storage: AuthStorage,
	provider: string,
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	assertManagedProvider(provider);
	let lifted = false;
	await storage.modify(provider, async (current) => {
		const credential = credentialFrom(current);
		const account = listAccounts(credential, (key) => env[key]).find((candidate) => candidate.name === name);
		if (!account) throw new Error(`Provider account not found: ${name}`);
		if (account.blockedUntil === undefined || account.blockReason === "auth_error") return current;
		lifted = true;
		const state = credential.slotState?.[name];
		return {
			...credential,
			...(state === undefined
				? {}
				: {
						slotState: {
							...credential.slotState,
							[name]: state.modelBlocks ? { modelBlocks: state.modelBlocks } : {},
						},
					}),
			accounts: (credential.accounts ?? []).map((candidate) => {
				if (candidate.name !== name) return candidate;
				const {
					blockedUntil: _blockedUntil,
					blockReason: _blockReason,
					blockedAt: _blockedAt,
					...rest
				} = candidate;
				return rest;
			}),
		};
	});
	const sessionScoped = forgetSessionBlocksFor(name);
	if (lifted || sessionScoped) emitProviderAccountsChanged(provider);
	return lifted || sessionScoped;
}

function assertManagedProvider(provider: string): void {
	if (provider !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
		throw new Error(`Provider account management is unavailable for: ${provider}`);
	}
}

function credentialFrom(credential: Credential | undefined): AnthropicSubscriptionCredential {
	if (credential === undefined) return emptyCredential();
	if (credential.type !== "oauth") throw new Error("Provider account management requires an OAuth credential");
	return credential as AnthropicSubscriptionCredential;
}
