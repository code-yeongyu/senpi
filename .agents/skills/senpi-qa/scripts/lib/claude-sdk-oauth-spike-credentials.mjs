/**
 * Credential loading for the claude-sdk-oauth live spikes.
 *
 * Kept in its own concept-named file so spike-support stays under the 250
 * pure-LOC ceiling. Never logs token material.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readAuthFile(sandbox) {
	try {
		const stored = JSON.parse(readFileSync(join(sandbox, "auth.json"), "utf8"));
		// Valid JSON is not enough: a null/array/primitive auth.json must produce
		// the documented credential rejection, not a raw TypeError on indexing.
		if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
			return { error: "credential_unreadable" };
		}
		return { stored };
	} catch {
		return { error: "credential_unreadable" };
	}
}

function asOauthCredential(credential) {
	// Fail closed on blank tokens too: an empty/whitespace access string would
	// otherwise be pinned as CLAUDE_CODE_OAUTH_TOKEN and surface as an opaque
	// auth failure deep in the SDK instead of the documented rejection.
	if (
		!credential ||
		credential.type !== "oauth" ||
		typeof credential.access !== "string" ||
		credential.access.trim().length === 0
	) {
		return undefined;
	}
	return credential;
}

/** Load a dummy-safe oauth credential from <sandbox>/auth.json. Never logs it. */
export function loadCredential(sandbox, slot = "claude-sdk-oauth-spike") {
	const { stored, error } = readAuthFile(sandbox);
	if (error) return { error };
	// Try each candidate in order and take the first USABLE one: a present but
	// malformed primary slot must not shadow a valid fallback.
	for (const candidate of [stored[slot], stored["claude-sdk-oauth"], stored.anthropic]) {
		const credential = asOauthCredential(candidate);
		if (credential) return { credential };
	}
	return { error: "credential_unavailable" };
}

/**
 * Load a credential from EXACTLY the named slot, with no fallback.
 *
 * The forgiving `loadCredential` fallback is wrong for multi-account scenarios:
 * it silently returns the primary slot when the second one was never seeded, so
 * a cross-account assertion would report success without ever exercising a
 * second account. Callers that need a distinct account must use this.
 */
export function loadCredentialStrict(sandbox, slot) {
	const { stored, error } = readAuthFile(sandbox);
	if (error) return { error };
	if (stored[slot] === undefined) return { error: `slot_missing_${slot}` };
	const credential = asOauthCredential(stored[slot]);
	return credential ? { credential } : { error: `slot_unusable_${slot}` };
}
