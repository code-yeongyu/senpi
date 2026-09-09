import { dirname, join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { listSlots, type PooledCredential, pinSlot, removeSlot } from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import { discoverEnvSlots } from "./credential-pool/env-slots.ts";
import { CredentialSlotRepository, type CredentialSlotState, slotHealth } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/claude-sdk-oauth/account-events.ts";
import { SENTINEL_OAUTH_FIELDS } from "./extensions/builtin/claude-sdk-oauth/accounts.ts";

export type CredentialAccountSource = "login" | "import" | "env";

/** Account metadata safe to surface: names and health only, never key material. */
export type CredentialAccountSummary = {
	readonly name: string;
	readonly source: CredentialAccountSource;
	readonly blocked: boolean;
	readonly pinned: boolean;
};

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

/** Storage-free variant for callers that already hold the credential (e.g. auth check). */
export async function summarizeCredentialAccounts(
	provider: string,
	stored: Credential | undefined,
	env: NodeJS.ProcessEnv = process.env,
	repository: CredentialSlotRepository = new CredentialSlotRepository(),
): Promise<CredentialAccountSummary[]> {
	const credential = pooledFrom(stored);
	const now = Date.now();
	const pinned = pinnedName(credential);
	const summaries: CredentialAccountSummary[] = [];

	if (credential) {
		const state = await repository.listSlots(provider, "stored");
		const storedAccounts =
			provider === "claude-sdk-oauth"
				? Array.isArray(credential.accounts)
					? listSlots(credential)
					: []
				: listSlots(credential);
		for (const slot of storedAccounts) {
			summaries.push({
				name: slot.name,
				source: slot.source ?? "login",
				blocked: slotBlocked(slot, state[slot.name], now),
				pinned: pinned === slot.name,
			});
		}
		if (provider !== "claude-sdk-oauth") return summaries;
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
			if (provider !== "claude-sdk-oauth" || name === null) {
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
