import type { Credential } from "@earendil-works/pi-ai";
import type { CredentialSlot, PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./extensions/builtin/anthropic-subscription/provider-id.ts";
import {
	type AccountSlot,
	type ClaudeCliAccountSlot,
	SENTINEL_OAUTH_FIELDS,
} from "./extensions/builtin/anthropic-subscription/accounts.ts";
import { newAccountDirId } from "./extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";

type AuthStorageData = Record<string, Credential>;
type Slot = Record<string, unknown>;

export type LegacySignOutResult = {
	data: AuthStorageData;
	migrated: boolean;
	/** Why an entry was left exactly as stored; the rest of the store is still signed out. */
	skipped?: string;
};

function isPlainObject(value: unknown): value is Slot {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthGrant(value: Slot): boolean {
	return typeof value.access === "string" && typeof value.refresh === "string" && typeof value.expires === "number";
}

function isKeySlot(value: Slot): boolean {
	return typeof value.key === "string" && value.access === undefined && value.refresh === undefined;
}

function isSlotList(value: unknown): value is Slot[] {
	return Array.isArray(value) && value.every(isPlainObject);
}

function anthropicKeySlots(entry: Slot): Slot[] | string {
	if (entry.accounts === undefined) return isOAuthGrant(entry) ? [] : "it holds no complete OAuth grant";
	if (!isSlotList(entry.accounts)) return "its accounts list is not a list of account objects";
	const keySlots = entry.accounts.filter(isKeySlot);
	if (keySlots.length + entry.accounts.filter(isOAuthGrant).length !== entry.accounts.length) {
		return "an account in it is neither a complete OAuth grant nor an API key";
	}
	return keySlots;
}

function remainingApiKeyEntry(keySlots: Slot[], pinned: unknown): PooledCredential | undefined {
	const accounts = keySlots as CredentialSlot[];
	const pinnedSlot = typeof pinned === "string" ? accounts.find((slot) => slot.name === pinned) : undefined;
	const key = (pinnedSlot ?? accounts[0])?.key;
	if (key === undefined) return undefined;
	return { type: "api_key", key, accounts, ...(pinnedSlot ? { pinned: pinnedSlot.name } : {}) };
}

function signedOutSlot(slot: Slot): ClaudeCliAccountSlot {
	return {
		name: slot.name as string,
		...(typeof slot.displayName === "string" ? { displayName: slot.displayName } : {}),
		source: "login",
		store: "claude-cli",
		dirId: newAccountDirId(),
		signInRequired: "legacy_sign_in_retired",
		...(isPlainObject(slot.modelBlocks)
			? { modelBlocks: slot.modelBlocks as ClaudeCliAccountSlot["modelBlocks"] }
			: {}),
	};
}

function isRetiredLoginSlot(slot: Slot): boolean {
	return slot.store === undefined && (slot.source === "login" || slot.source === "import");
}

function signOutSubscription(stored: unknown): { entry: unknown; changed: boolean } | string {
	if (stored === undefined) return { entry: stored, changed: false };
	if (!isPlainObject(stored)) return "the anthropic-subscription entry is not an object";
	if (stored.accounts !== undefined && !isSlotList(stored.accounts)) {
		return "the anthropic-subscription accounts are not account objects";
	}
	const accounts = stored.accounts ?? [];
	if (accounts.some((slot) => isRetiredLoginSlot(slot) && typeof slot.name !== "string")) {
		return "an anthropic-subscription account has no name";
	}
	if (!accounts.some(isRetiredLoginSlot)) return { entry: stored, changed: false };
	const signedOut = accounts.map((slot) => (isRetiredLoginSlot(slot) ? signedOutSlot(slot) : (slot as AccountSlot)));
	return { entry: { ...stored, ...SENTINEL_OAUTH_FIELDS, accounts: signedOut }, changed: true };
}

function signOutAnthropic(stored: unknown): { entry: unknown; changed: boolean } | string {
	if (!isPlainObject(stored) || stored.type !== "oauth") return { entry: stored, changed: false };
	const keySlots = anthropicKeySlots(stored);
	if (typeof keySlots === "string") return keySlots;
	return { entry: remainingApiKeyEntry(keySlots, stored.pinned), changed: true };
}

function signOut(data: AuthStorageData): LegacySignOutResult {
	const skipped: string[] = [];
	let next: AuthStorageData = data;
	const subscription = signOutSubscription(data[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]);
	if (typeof subscription === "string") skipped.push(subscription);
	else if (subscription.changed) {
		next = { ...next, [ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]: subscription.entry as Credential };
	}
	const anthropic = signOutAnthropic(data.anthropic);
	if (typeof anthropic === "string") skipped.push(`the anthropic entry: ${anthropic}`);
	else if (anthropic.changed) {
		next = { ...next };
		if (anthropic.entry === undefined) delete next.anthropic;
		else next.anthropic = anthropic.entry as Credential;
	}
	return {
		data: next,
		migrated: next !== data,
		...(skipped.length === 0 ? {} : { skipped: skipped.join("; ") }),
	};
}

/**
 * Signs out every Claude subscription login from the retired senpi-owned sign-in (senpi#4436), once, at the auth.json
 * load seam. No token is copied or kept anywhere:
 * - an `anthropic-subscription` slot holding a token (`source` login or import) becomes a Claude CLI slot that must
 *   sign in again, under the same name, display name and model blocks, so the pin and order still name it;
 * - the OAuth part of an `anthropic` entry is dropped; its API-key slots stay as an API-key credential;
 * - env slots and Claude CLI slots are untouched, and a store with nothing left to sign out is returned as is.
 * An entry it cannot parse is left exactly as stored and explained in `skipped`; it never throws.
 */
export function signOutLegacyClaudeLogins(data: AuthStorageData): LegacySignOutResult {
	try {
		return signOut(data);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { data, migrated: false, skipped: `it could not be read (${reason})` };
	}
}
