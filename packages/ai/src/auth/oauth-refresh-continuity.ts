import type { OAuthCredential } from "./types.ts";

/**
 * Bind one completed refresh to both its input and output. A writer that copies
 * old metadata onto different tokens cannot make those tokens a continuation.
 */
export async function refreshContinuity(previous: OAuthCredential, current: OAuthCredential): Promise<string> {
	const input = JSON.stringify([previous.access, previous.refresh, current.access, current.refresh]);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
