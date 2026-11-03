import type { Credential } from "../types.ts";

/**
 * Marks a credential a sign-in is about to store with a fresh `loginId`. Only sign-in paths call
 * this (logins and account imports); a token refresh rewrites the material and keeps or drops the
 * id but never mints one, so a new non-empty id means a person signed in again, never that a token
 * rotated (senpi#4099). The id is random, not key material.
 */
export function stampLogin(credential: Credential): Credential {
	return { ...credential, loginId: globalThis.crypto.randomUUID() };
}
