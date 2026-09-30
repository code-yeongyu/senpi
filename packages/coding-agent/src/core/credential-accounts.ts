import { dirname, join } from "node:path";
import { type Credential, extractChatGptSubscriptionAccountId, normalizeProviderId } from "@earendil-works/pi-ai";
import {
	accountDisplayName,
	listSlots,
	type PooledCredential,
	pinSlot,
	removeSlot,
	renameSlotDisplayName,
} from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import { discoverEnvSlots } from "./credential-pool/env-slots.ts";
import { CredentialSlotRepository, type CredentialSlotState, slotHealth } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/anthropic-subscription/account-events.ts";
import { SENTINEL_OAUTH_FIELDS } from "./extensions/builtin/anthropic-subscription/accounts.ts";

export type CredentialAccountSource = "login" | "import" | "env";

/** Account metadata safe to surface; never credential material. */
export type CredentialAccountSummary = {
	readonly name: string;
	readonly displayName?: string;
	readonly verifiedEmail?: string;
	/** Bounded routing discriminator, not proof of verified identity. */
	readonly workspaceHint?: string;
	readonly identitySource?: "verified-email" | "manual-name" | "slot-id";
	readonly source: CredentialAccountSource;
	readonly blocked: boolean;
	readonly pinned: boolean;
	readonly expiresAt?: number;
	readonly expiresInMs?: number;
	readonly authAction?:
		| "valid"
		| "refresh-on-use"
		| "reauth-required"
		| "temporarily-unavailable"
		| "account-disabled"
		| "unknown";
};

/** Preserve immutable ID selection; other identifiers must resolve to exactly one account. */
export function resolveCredentialAccountSelector(
	accounts: readonly CredentialAccountSummary[],
	selector: string,
): string {
	const input = selector.trim();
	const byId = accounts.find((account) => account.name === input);
	if (byId) return byId.name;

	const normalized = input.toLowerCase();
	const matches = accounts.filter((account) => {
		const email = account.verifiedEmail?.toLowerCase();
		const localPart = email?.includes("@") ? email.slice(0, email.indexOf("@")) : undefined;
		return email === normalized || localPart === normalized || account.displayName?.toLowerCase() === normalized;
	});
	if (matches.length === 1) return matches[0].name;
	if (matches.length > 1) {
		throw new Error(`Ambiguous account selector: ${matches.map((account) => account.name).join(", ")}`);
	}
	throw new Error("Provider account not found. Use /gpt-account to list accounts.");
}

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidAccountName(name: string): void {
	if (!ACCOUNT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid account name '${name}': use letters, digits, '-' or '_', starting with a letter or digit`,
		);
	}
}

function pooledFrom(credential: Credential | undefined): PooledCredential | undefined {
	return credential === undefined ? undefined : credential;
}

function pinnedName(credential: PooledCredential | undefined): string | undefined {
	return credential?.pinned;
}

function numberField(value: object, key: string): number | undefined {
	const found = Object.entries(value).find(([candidate]) => candidate === key)?.[1];
	return typeof found === "number" ? found : undefined;
}

function defaultRepository(storage: AuthStorage): CredentialSlotRepository {
	const authPath = storage.getStoragePath();
	return new CredentialSlotRepository(authPath ? join(dirname(authPath), "credential-pool-state.json") : undefined);
}

function stringField(value: object, key: string): string | undefined {
	const found = Object.entries(value).find(([candidate]) => candidate === key)?.[1];
	return typeof found === "string" ? found : undefined;
}

/**
 * Block state has two sources and both are authoritative: a slot persisted by an
 * existing provider lane carries its own `blockedUntil`/`blockReason` inside
 * auth.json, while generic pool failover records health in the sidecar. Reading
 * only one would silently downgrade a real block to "available".
 */
function slotBlocked(slot: object, sidecar: CredentialSlotState | undefined, now: number): boolean {
	if (slotHealth(sidecar, now) === "blocked") return true;
	const reason = stringField(slot, "blockReason");
	if (reason === "auth_error" || reason === "account_disabled") return true;
	const blockedUntil = numberField(slot, "blockedUntil");
	return blockedUntil !== undefined && blockedUntil > now;
}

/**
 * Lists a provider's credential accounts for ANY provider, not just one lane.
 * Stored slots own the listing when a credential exists; env slots are listed
 * only when nothing is stored, mirroring resolution precedence exactly. Health
 * comes from the pool sidecar, so a cooldown persisted by a failover shows up
 * here without auth.json ever carrying block state.
 */
export async function getCredentialAccounts(
	storage: AuthStorage,
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
	repository?: CredentialSlotRepository,
): Promise<CredentialAccountSummary[]> {
	return summarizeCredentialAccounts(provider, storage.get(provider), env, repository ?? defaultRepository(storage));
}

export type CredentialAccountSnapshot = {
	readonly accounts: readonly CredentialAccountSummary[];
	/** Earliest absolute boundary after which this advice must not be displayed. */
	readonly validUntil?: number;
};

/** Strict, refresh-free read for disposable UI snapshots. No credential material escapes. */
export async function getCredentialAccountSnapshot(
	storage: AuthStorage,
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
	repository: CredentialSlotRepository = defaultRepository(storage),
): Promise<CredentialAccountSnapshot> {
	const stored = await storage.readStoredSnapshot(provider);
	let validUntil: number | undefined;
	const accounts = await summarizeAccounts(provider, stored, env, repository, (boundary) => {
		validUntil = Math.min(validUntil ?? Infinity, boundary);
	});
	return { accounts, ...(validUntil === undefined ? {} : { validUntil }) };
}

/** Storage-free variant for callers that already hold the credential (e.g. auth check). */
export async function summarizeCredentialAccounts(
	provider: string,
	stored: Credential | undefined,
	env: NodeJS.ProcessEnv = process.env,
	repository: CredentialSlotRepository = new CredentialSlotRepository(),
): Promise<CredentialAccountSummary[]> {
	return summarizeAccounts(provider, stored, env, repository);
}

async function summarizeAccounts(
	provider: string,
	stored: Credential | undefined,
	env: NodeJS.ProcessEnv,
	repository: CredentialSlotRepository,
	onBoundary?: (boundary: number) => void,
): Promise<CredentialAccountSummary[]> {
	const credential = pooledFrom(stored);
	const now = Date.now();
	const pinned = pinnedName(credential);
	const isChatGptSubscription = normalizeProviderId(provider) === "chatgpt-subscription";
	const summaries: CredentialAccountSummary[] = [];

	if (credential) {
		const state = await repository.listSlots(provider, "stored");
		// Read boundary (senpi#1989): a caller may still pass the legacy provider
		// id (an older session, a stored account payload), so compare normalized.
		const storedAccounts =
			normalizeProviderId(provider) === "anthropic-subscription"
				? Array.isArray(credential.accounts)
					? listSlots(credential)
					: []
				: listSlots(credential);
		for (const slot of storedAccounts) {
			const displayName = accountDisplayName(slot.displayName);
			const persisted = state[slot.name];
			const revision = await repository.storedCredentialRevision(provider, slot.name, {
				key: slot.key,
				access: slot.access,
				refresh: slot.refresh,
			});
			// A block belongs to the material that earned it; a re-login starts clean.
			const applicable = persisted?.credentialRevision === revision ? persisted : undefined;
			const blocked = slotBlocked(slot, applicable, now);
			const expiresAt =
				typeof slot.expires === "number" &&
				Number.isFinite(slot.expires) &&
				slot.expires > 0 &&
				slot.expires <= 8_640_000_000_000_000
					? slot.expires
					: undefined;
			for (const boundary of [expiresAt, applicable?.blockedUntil, numberField(slot, "blockedUntil")]) {
				if (boundary !== undefined && boundary > now) onBoundary?.(boundary);
			}
			const reasons = [applicable?.blockReason, stringField(slot, "blockReason")];
			let authAction: CredentialAccountSummary["authAction"] = "unknown";
			if (reasons.includes("auth_error")) authAction = "reauth-required";
			else if (reasons.includes("account_disabled")) authAction = "account-disabled";
			else if (blocked) authAction = "temporarily-unavailable";
			else if (expiresAt !== undefined) {
				authAction = expiresAt > now ? "valid" : slot.refresh ? "refresh-on-use" : "reauth-required";
			}
			const verifiedEmail = isChatGptSubscription ? slot.verifiedIdentity?.verifiedEmail : undefined;
			const routingId =
				isChatGptSubscription && slot.verifiedIdentity === undefined && slot.access
					? extractChatGptSubscriptionAccountId(slot.access)
					: undefined;
			const workspaceHint =
				slot.verifiedIdentity?.workspaceId.slice(-8) ??
				(routingId !== undefined && /^[a-zA-Z0-9_-]{9,128}$/.test(routingId) ? routingId.slice(-8) : undefined);
			summaries.push({
				name: slot.name,
				...(displayName === undefined ? {} : { displayName }),
				source: slot.source ?? "login",
				blocked,
				pinned: pinned === slot.name,
				...(isChatGptSubscription
					? {
							...(expiresAt === undefined ? {} : { expiresAt, expiresInMs: Math.max(0, expiresAt - now) }),
							authAction,
							...(verifiedEmail === undefined ? {} : { verifiedEmail }),
							...(workspaceHint === undefined ? {} : { workspaceHint }),
							identitySource: verifiedEmail ? "verified-email" : displayName ? "manual-name" : "slot-id",
						}
					: {}),
			});
		}
		if (normalizeProviderId(provider) !== "anthropic-subscription") return summaries;
	}

	const state = await repository.listSlots(provider, "env");
	for (const slot of discoverEnvSlots(provider, (name) => env[name])) {
		const persisted = state[slot.name];
		const revision = await repository.envCredentialRevision(slot.envVarName, slot.key);
		// A block belongs to the value that earned it; a rotated env key starts clean.
		const applicable = persisted?.credentialRevision === revision ? persisted : undefined;
		summaries.push({
			name: slot.name,
			source: "env",
			blocked: slotHealth(applicable, now) === "blocked",
			pinned: pinned === slot.name,
		});
	}
	return summaries;
}

/** Atomically rename/clear stored metadata without changing identity, health or environment state. */
export async function renameCredentialAccount(
	storage: AuthStorage,
	provider: string,
	name: string,
	displayName: string | null,
): Promise<void> {
	await storage.modify(provider, async (current) => {
		if (!current) throw new Error(`No stored credential for provider: ${provider}`);
		// Provider-managed OAuth sentinels without an accounts array are not legacy flat accounts.
		// Key this on the credential shape, not one provider id, so sibling managed lanes cannot be promoted.
		if (
			current.type === "oauth" &&
			!Array.isArray((current as { accounts?: unknown }).accounts) &&
			current.access === current.refresh &&
			current.access.endsWith("-managed")
		) {
			throw new Error(`Stored provider account not found: ${name}`);
		}
		return renameSlotDisplayName(current, name, displayName);
	});
	emitProviderAccountsChanged(provider);
}

/** Pins one slot, or clears the pin when `name` is null. */
export async function pinCredentialAccount(
	storage: AuthStorage,
	provider: string,
	name: string | null,
	env: NodeJS.ProcessEnv = process.env,
	repository?: CredentialSlotRepository,
): Promise<void> {
	const repo = repository ?? defaultRepository(storage);
	if (name !== null) {
		assertValidAccountName(name);
		const accounts = await getCredentialAccounts(storage, provider, env, repo);
		if (!accounts.some((account) => account.name === name)) {
			throw new Error(`Provider account not found: ${name}`);
		}
	}
	await storage.modify(provider, async (current) => {
		if (current === undefined) {
			if (normalizeProviderId(provider) !== "anthropic-subscription" || name === null) {
				throw new Error(`No stored credential for provider: ${provider}`);
			}
			return pinSlot({ type: "oauth", ...SENTINEL_OAUTH_FIELDS, accounts: [] }, name);
		}
		if (name === null) {
			if (pinnedName(current) === undefined) return current;
			const { pinned: _pinned, ...unpinned } = { ...current, pinned: undefined };
			return unpinned;
		}
		return pinSlot(current, name);
	});
	// Subscribed clients re-read the list after any mutation; skipping this leaves
	// a desktop account picker showing a stale pin.
	emitProviderAccountsChanged(provider);
}

/**
 * Removes one stored slot. Env-backed accounts are refused: they are owned by
 * the environment, and deleting one here would silently disagree with the
 * variable that still defines it.
 */
export async function removeCredentialAccount(
	storage: AuthStorage,
	provider: string,
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	repository?: CredentialSlotRepository,
): Promise<void> {
	const repo = repository ?? defaultRepository(storage);
	const accounts = await getCredentialAccounts(storage, provider, env, repo);
	const account = accounts.find((candidate) => candidate.name === name);
	if (!account) throw new Error(`Provider account not found: ${name}`);
	if (account.source === "env") {
		throw new Error(`Environment provider account cannot be removed: ${name}`);
	}
	const next = await storage.read(provider);
	if (next === undefined) throw new Error(`No stored credential for provider: ${provider}`);
	const remaining = removeSlot(next, name);
	if (remaining === undefined) await storage.delete(provider);
	else await storage.modify(provider, async () => remaining);
	await repo.mutateSlotState(provider, "stored", name, () => undefined);
	emitProviderAccountsChanged(provider);
}
