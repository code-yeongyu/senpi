import type { Credential } from "@earendil-works/pi-ai";
import type { CredentialSlot, PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./extensions/builtin/anthropic-subscription/account-management.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	authGrantDigest,
	emptyCredential,
} from "./extensions/builtin/anthropic-subscription/accounts.ts";

type AuthStorageData = Record<string, Credential>;
type Slot = Record<string, unknown>;
type OAuthGrant = Slot & { access: string; refresh: string; expires: number };

export type AnthropicOAuthMigrationResult = {
	data: AuthStorageData;
	migrated: boolean;
	/** Why an `anthropic` OAuth entry was left exactly as stored; set only when nothing was written. */
	skipped?: string;
};

function isPlainObject(value: unknown): value is Slot {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthGrant(value: Slot): value is OAuthGrant {
	return typeof value.access === "string" && typeof value.refresh === "string" && typeof value.expires === "number";
}

function isKeySlot(value: Slot): boolean {
	return typeof value.key === "string" && value.access === undefined && value.refresh === undefined;
}

function isSlotList(value: unknown): value is Slot[] {
	return Array.isArray(value) && value.every(isPlainObject);
}

type Source = { grants: OAuthGrant[]; keySlots: Slot[]; pooled: boolean; pinned: unknown };

function readSource(entry: Slot): Source | string {
	if (entry.accounts === undefined) {
		return isOAuthGrant(entry)
			? { grants: [entry], keySlots: [], pooled: false, pinned: undefined }
			: "it holds no complete OAuth grant";
	}
	if (!isSlotList(entry.accounts)) return "its accounts list is not a list of account objects";
	const slotGrants = entry.accounts.filter(isOAuthGrant);
	const keySlots = entry.accounts.filter(isKeySlot);
	if (slotGrants.length + keySlots.length !== entry.accounts.length) {
		return "an account in it is neither a complete OAuth grant nor an API key";
	}
	const flatIsExtra = isOAuthGrant(entry) && !slotGrants.some((slot) => slot.refresh === entry.refresh);
	const grants = flatIsExtra ? [...slotGrants, { ...entry, name: undefined } as OAuthGrant] : slotGrants;
	if (grants.length === 0) return "it holds no complete OAuth grant";
	return { grants, keySlots, pooled: true, pinned: entry.pinned };
}

function readSubscription(stored: unknown): AnthropicSubscriptionCredential | string {
	if (stored === undefined) return emptyCredential();
	if (!isPlainObject(stored)) return "the existing anthropic-subscription entry is not an object";
	if (stored.accounts === undefined) return stored as AnthropicSubscriptionCredential;
	if (!isSlotList(stored.accounts) || !stored.accounts.every((slot) => typeof slot.name === "string")) {
		return "the existing anthropic-subscription accounts are not account objects";
	}
	return stored as AnthropicSubscriptionCredential;
}

function importedSlotName(slot: Slot, pooled: boolean, taken: ReadonlySet<string>): string {
	const base =
		pooled && typeof slot.name === "string" && slot.name ? `imported-anthropic-${slot.name}` : "imported-anthropic";
	let name = base.slice(0, 64);
	for (let suffix = 2; taken.has(name); suffix++) name = `${base.slice(0, 58)}-${suffix}`;
	return name;
}

function remainingApiKeyEntry(keySlots: Slot[], pinned: unknown): PooledCredential | undefined {
	const accounts = keySlots as CredentialSlot[];
	const pinnedSlot = typeof pinned === "string" ? accounts.find((slot) => slot.name === pinned) : undefined;
	const key = (pinnedSlot ?? accounts[0])?.key;
	if (key === undefined) return undefined;
	return { type: "api_key", key, accounts, ...(pinnedSlot ? { pinned: pinnedSlot.name } : {}) };
}

/** Field on the source `anthropic` entry: digests of its grants already copied into the subscription lane. */
export const IMPORTED_GRANTS_FIELD = "importedToSubscription";

function importedDigests(entry: Slot): Set<string> {
	const recorded = entry[IMPORTED_GRANTS_FIELD];
	return new Set(Array.isArray(recorded) ? recorded.filter((digest) => typeof digest === "string") : []);
}

function copyGrants(
	data: AuthStorageData,
	entry: Slot,
	source: Source,
	subscription: AnthropicSubscriptionCredential,
	unrecorded: OAuthGrant[],
): AuthStorageData {
	const accounts: AccountSlot[] = [...(subscription.accounts ?? [])];
	const taken = new Set(accounts.map((slot) => slot.name));
	let pinned = subscription.pinned;
	for (const grant of unrecorded) {
		const digest = authGrantDigest(grant.refresh);
		let account = accounts.find((slot) => slot.refresh === grant.refresh || slot.importedFrom === digest);
		if (!account) {
			const name = importedSlotName(grant, source.pooled, taken);
			taken.add(name);
			const displayName = typeof grant.displayName === "string" ? { displayName: grant.displayName } : {};
			account = {
				name,
				...displayName,
				access: grant.access,
				refresh: grant.refresh,
				expires: grant.expires,
				source: "import",
				importedFrom: digest,
			};
			accounts.push(account);
		}
		if (pinned === undefined && typeof grant.name === "string" && grant.name === source.pinned) pinned = account.name;
	}
	const recorded = [
		...new Set([...importedDigests(entry), ...source.grants.map((grant) => authGrantDigest(grant.refresh))]),
	];
	return {
		...data,
		anthropic: Object.assign({}, data.anthropic, { [IMPORTED_GRANTS_FIELD]: recorded }),
		[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]: { ...subscription, accounts, ...(pinned === undefined ? {} : { pinned }) },
	};
}

function migrate(data: AuthStorageData): AnthropicOAuthMigrationResult {
	const entry: unknown = data.anthropic;
	if (!isPlainObject(entry) || entry.type !== "oauth") return { data, migrated: false };
	const source = readSource(entry);
	if (typeof source === "string") return { data, migrated: false, skipped: source };
	const subscription = readSubscription(data[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]);
	if (typeof subscription === "string") return { data, migrated: false, skipped: subscription };
	const recorded = importedDigests(entry);
	const unrecorded = source.grants.filter((grant) => !recorded.has(authGrantDigest(grant.refresh)));
	if (unrecorded.length > 0)
		return { data: copyGrants(data, entry, source, subscription, unrecorded), migrated: true };
	const next: AuthStorageData = { ...data };
	const remaining = remainingApiKeyEntry(source.keySlots, source.pinned);
	if (remaining) next.anthropic = remaining;
	else delete next.anthropic;
	return { data: next, migrated: true };
}

/**
 * Moves a Claude subscription login out of the direct `anthropic` provider into the Agent SDK lane
 * (senpi#3259). Anthropic bills a subscription token sent straight to the Messages API as a
 * third-party app (extra usage, not plan limits), so the grant must run through Claude Code.
 *
 * Two steps, one per auth.json load, so no credential is ever lost:
 * 1. Copy: every OAuth grant of the entry (each pool slot, and top-level fields that match no slot)
 *    not yet recorded is ADDED to the subscription lane once (de-duplicated by refresh token, tagged
 *    `importedFrom`), and the SAME write records its digest on the source entry. The source keeps
 *    every credential it had.
 * 2. Retire: a later load that finds every source grant recorded removes the OAuth part of
 *    `anthropic`; seeing the record proves the copy was persisted with it. Recorded grants are never
 *    copied again, so an account the user removed in between stays removed. API-key slots stay,
 *    rebuilt as an API-key credential projecting the pinned key. Nothing refreshes the leftover copy in
 *    between: `anthropic` has no OAuth method. An older binary that rotates it meanwhile produces a new,
 *    unrecorded grant, which is copied as a new account (the old copy is then dead, nothing is lost).
 * Anything it cannot fully parse is left untouched and explained in `skipped`; it never throws, so a
 * broken entry can never take other providers' credentials down with it.
 */
export function migrateAnthropicOAuthToSubscription(data: AuthStorageData): AnthropicOAuthMigrationResult {
	try {
		return migrate(data);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { data, migrated: false, skipped: `it could not be read (${reason})` };
	}
}
