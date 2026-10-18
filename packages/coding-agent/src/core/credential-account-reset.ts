import type { CredentialSlot, PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import { credentialPoolRepository, getCredentialAccounts } from "./credential-accounts.ts";
import type { CredentialSlotRepository } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/anthropic-subscription/account-events.ts";

/** Block fields a provider lane may keep on a stored account in auth.json. */
type StoredBlockFields = { blockReason?: unknown; blockedUntil?: unknown; modelBlocks?: unknown };

function withoutBlock({
	blockReason: _reason,
	blockedUntil: _until,
	modelBlocks: _models,
	...slot
}: CredentialSlot & StoredBlockFields): CredentialSlot {
	return slot;
}

function clearStoredBlock(
	credential: PooledCredential & { slotState?: Record<string, unknown> },
	name: string,
): PooledCredential {
	const accounts = credential.accounts?.map((slot) => (slot.name === name ? withoutBlock(slot) : slot));
	const { [name]: _cleared, ...slotState } = credential.slotState ?? {};
	return {
		...credential,
		...(accounts === undefined ? {} : { accounts }),
		...(credential.slotState === undefined ? {} : { slotState }),
	};
}

/**
 * Clears one account's cooldown or block so the next request tries it again
 * (senpi#3285). Both health sources are cleared: the pool sidecar and a block a
 * provider lane stored on the account itself. Nothing else about the account
 * changes; if it is still unhealthy, the next request blocks it again.
 */
export async function resetCredentialAccount(
	storage: AuthStorage,
	provider: string,
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	repository?: CredentialSlotRepository,
): Promise<void> {
	const repo = repository ?? credentialPoolRepository(storage);
	const accounts = await getCredentialAccounts(storage, provider, env, repo);
	const account = accounts.find((candidate) => candidate.name === name);
	if (!account) throw new Error(`Provider account not found: ${name}`);
	await repo.mutateSlotState(provider, account.source === "env" ? "env" : "stored", name, () => undefined);
	if (storage.get(provider) !== undefined) {
		await storage.modify(provider, async (current) =>
			current === undefined ? current : clearStoredBlock(current, name),
		);
	}
	emitProviderAccountsChanged(provider);
}
