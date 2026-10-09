import type { Credential } from "@earendil-works/pi-ai";
import { LEGACY_PROVIDER_IDS } from "@earendil-works/pi-ai";

type AuthStorageData = Record<string, Credential>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One-shot auth.json provider-key migration for the provider rename (#1989):
 * a credential stored under a legacy provider id (`openai-codex`,
 * `claude-sdk-oauth`) is rewritten under its canonical id
 * (`chatgpt-subscription`, `anthropic-subscription`).
 *
 * Completion is derived from the data, not a migrations-state marker: once the
 * legacy key is absent the function is a no-op, so a busy credential store can
 * skip a load and retry later, and an older binary re-introducing a legacy key
 * after the fact still gets migrated. The credential object moves VERBATIM —
 * pools (`accounts`, `login-N` names, `pinned`, `slotState`) and the
 * managed-sentinel values inside the flat fields are preserved under the new
 * key, byte for byte.
 *
 * Conflict rule: when both keys hold an entry, the canonical entry wins and
 * the legacy entry is removed from the live file only — the timestamped backup
 * taken before the rewrite still holds it. Entries are never merged: one
 * single-use OAuth grant must not end up with two refresh owners.
 */
export function migrateLegacyProviderKeys(data: AuthStorageData): { data: AuthStorageData; migrated: boolean } {
	let next: AuthStorageData | undefined;
	for (const [legacyId, canonicalId] of Object.entries(LEGACY_PROVIDER_IDS)) {
		const legacy = data[legacyId];
		// Only plain-object entries move; anything else found on the key stays
		// put for a human to inspect rather than being renamed blind.
		if (!isPlainObject(legacy)) continue;
		next ??= { ...data };
		delete next[legacyId];
		if (next[canonicalId] === undefined) {
			next[canonicalId] = legacy as Credential;
		}
	}
	return next ? { data: next, migrated: true } : { data, migrated: false };
}
