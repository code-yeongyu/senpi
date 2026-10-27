import type { Credential } from "../types.ts";

/**
 * Marks a credential a sign-in is about to store with a fresh `loginId`. Only login paths call
 * this; a token refresh rewrites the material and keeps the id, so a changed id means a person
 * signed in again, never that a token rotated (senpi#4099). The id is random, not key material.
 */
export function stampLogin(credential: Credential): Credential {
	return { ...credential, loginId: globalThis.crypto.randomUUID() };
}
