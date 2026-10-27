import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import { credentialPoolRepository, getCredentialAccounts } from "./credential-accounts.ts";

/**
 * The retry-fallback recovery revision of `provider` (senpi#4099): every stored slot's
 * installation-keyed HMAC revision (the same one that retires a slot's pool block on re-login,
 * never raw material) plus the names of its blocked slots. It stays in session memory only.
 * An unreadable store answers `undefined`, which never releases anything.
 */
export async function credentialRecoveryRevision(
	storage: AuthStorage | undefined,
	provider: string,
): Promise<string | undefined> {
	if (!storage) return undefined;
	try {
		// The async read picks up a login another process wrote since this one last loaded.
		await storage.read(provider);
		const repository = credentialPoolRepository(storage);
		const slots = await Promise.all(
			listSlots(storage.get(provider)).map(
				async (slot) => `${slot.name}=${await repository.storedCredentialRevision(provider, slot.name, slot)}`,
			),
		);
		const accounts = await getCredentialAccounts(storage, provider, process.env, repository);
		const blocked = accounts.filter((account) => account.blocked).map((account) => account.name);
		return JSON.stringify({ slots, blocked });
	} catch {
		return undefined;
	}
}
