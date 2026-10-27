import type { AuthStorage } from "./auth-storage.ts";

/**
 * The retry-fallback recovery revision of `provider` (senpi#4099): the `loginId` the last sign-in
 * stored, or "" when none did. A token refresh keeps the id or drops it to "" and never mints one, so
 * only a sign-in moves it to a new non-empty value. The
 * metadata read reloads another process's write without resolving key references. An unreadable
 * store answers `undefined`, which never releases anything.
 */
export async function credentialRecoveryRevision(
	storage: AuthStorage | undefined,
	provider: string,
): Promise<string | undefined> {
	if (!storage) return undefined;
	try {
		await storage.list();
		return storage.get(provider)?.loginId ?? "";
	} catch {
		return undefined;
	}
}
