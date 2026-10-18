import type { Credential } from "@earendil-works/pi-ai";
import { accountDisplayName } from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "../../../auth-storage.ts";
import { emitProviderAccountsChanged } from "./account-events.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
	listAccounts,
	pinAccount,
	removeAccount,
} from "./accounts.ts";
import { forgetSessionBlocksFor } from "./failover.ts";

export const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";

export type ProviderAccountSummary = {
	readonly name: string;
	readonly displayName?: string;
	readonly source: AccountSlot["source"];
	readonly blocked: boolean;
	readonly pinned: boolean;
};

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
			blocked: account.blockedUntil !== undefined && account.blockedUntil > now,
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

export async function removeProviderAccount(storage: AuthStorage, provider: string, name: string): Promise<void> {
	assertManagedProvider(provider);
	await storage.modify(provider, async (current) => {
		const credential = credentialFrom(current);
		const account = (credential.accounts ?? []).find((candidate) => candidate.name === name);
		if (!account) {
			const environmentAccount = listAccounts(credential, (key) => process.env[key]).find(
				(candidate) => candidate.name === name,
			);
			if (environmentAccount?.source === "env") {
				throw new Error(`Environment provider account cannot be removed: ${name}`);
			}
			throw new Error(`Provider account not found: ${name}`);
		}
		return removeAccount(credential, name);
	});
	emitProviderAccountsChanged(provider);
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
