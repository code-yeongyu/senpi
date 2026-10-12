import { dirname, join } from "node:path";
import { type Credential, normalizeProviderId } from "@earendil-works/pi-ai";
import {
	accountDisplayName,
	listSlots,
	type PooledCredential,
	pinSlot,
	removeSlot,
	renameSlotDisplayName,
	replaceSlotMaterial,
} from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import { discoverEnvSlots } from "./credential-pool/env-slots.ts";
import { type ModelBlocks, pruneModelBlocks } from "./credential-pool/model-scope.ts";
import { CredentialSlotRepository, type CredentialSlotState, slotHealth } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/anthropic-subscription/account-events.ts";
import { SENTINEL_OAUTH_FIELDS } from "./extensions/builtin/anthropic-subscription/accounts.ts";

export type CredentialAccountSource = "login" | "import" | "env";

/** Account metadata safe to surface: names and health only, never key material. */
export type CredentialAccountSummary = {
	readonly name: string;
	readonly displayName?: string;
	readonly source: CredentialAccountSource;
	readonly blocked: boolean;
	/** Why an account-wide block holds (senpi#3216); absent while the account is available. */
	readonly blockReason?: "rate_limit" | "auth_error" | "account_disabled";
	/** When a `rate_limit` block lifts on its own; auth and billing blocks have no expiry. */
	readonly blockedUntil?: number;
	readonly pinned: boolean;
	/** Usage limits binding one model (family) while the account serves the rest (senpi#2555). */
	readonly blockedModels?: readonly { readonly model: string; readonly until: number }[];
};

/**
 * How a listing shows an account's health (senpi#3216): a usage limit with the time it lifts, an
 * auth or billing block with the action that clears it. `reauthCommand` names the provider's
 * in-place re-login, e.g. `/gpt-account login <id>`.
 */
export function describeAccountHealth(
	account: Pick<CredentialAccountSummary, "name" | "blocked" | "blockReason" | "blockedUntil"> & {
		readonly source?: CredentialAccountSource;
	},
	reauthCommand?: (name: string) => string,
): string {
	if (!account.blocked) return "available";
	// An environment account is fixed by changing its variable; no command can log it in again.
	const relogin =
		account.source === "env"
			? "a new key in its environment variable"
			: reauthCommand === undefined
				? "log in again"
				: reauthCommand(account.name);
	switch (account.blockReason) {
		case "auth_error":
			return `blocked: login rejected, fix with ${relogin}`;
		case "account_disabled":
			return `blocked: account or billing disabled, check the provider account, then ${relogin}`;
		default:
			return account.blockedUntil === undefined
				? "blocked: usage limit"
				: `blocked: usage limit until ${new Date(account.blockedUntil).toISOString()}`;
	}
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
	return slotBlock(slot, sidecar, now) !== undefined;
}

type SlotBlock = Pick<CredentialAccountSummary, "blockReason" | "blockedUntil">;

/** The account-wide block that holds now, from the pool sidecar first, then the stored slot. */
function slotBlock(slot: object, sidecar: CredentialSlotState | undefined, now: number): SlotBlock | undefined {
	if (slotHealth(sidecar, now) === "blocked") return describedBlock(sidecar?.blockReason, sidecar?.blockedUntil);
	const reason = stringField(slot, "blockReason");
	if (reason === "auth_error" || reason === "account_disabled") return { blockReason: reason };
	const blockedUntil = numberField(slot, "blockedUntil");
	return blockedUntil !== undefined && blockedUntil > now ? describedBlock(reason, blockedUntil) : undefined;
}

function describedBlock(reason: string | undefined, blockedUntil: number | undefined): SlotBlock {
	if (reason === "auth_error" || reason === "account_disabled") return { blockReason: reason };
	return { blockReason: "rate_limit", ...(blockedUntil === undefined ? {} : { blockedUntil }) };
}

function storedModelBlocks(slot: object): ModelBlocks | undefined {
	const found = Object.entries(slot).find(([candidate]) => candidate === "modelBlocks")?.[1];
	if (found === null || typeof found !== "object") return undefined;
	const entries = Object.entries(found).flatMap(([model, block]) => {
		const until = block !== null && typeof block === "object" ? numberField(block, "blockedUntil") : undefined;
		return until === undefined ? [] : [[model, { blockedUntil: until }] as const];
	});
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Live model blocks from every source, the latest expiry winning per model. */
function blockedModels(
	now: number,
	...sources: (ModelBlocks | undefined)[]
): Pick<CredentialAccountSummary, "blockedModels"> {
	const until = new Map<string, number>();
	for (const blocks of sources) {
		for (const [model, block] of Object.entries(pruneModelBlocks(blocks, now) ?? {})) {
			until.set(model, Math.max(until.get(model) ?? 0, block.blockedUntil));
		}
	}
	return until.size === 0 ? {} : { blockedModels: [...until].map(([model, at]) => ({ model, until: at })) };
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
			summaries.push({
				name: slot.name,
				...(displayName === undefined ? {} : { displayName }),
				source: slot.source ?? "login",
				blocked: slotBlocked(slot, applicable, now),
				...slotBlock(slot, applicable, now),
				pinned: pinned === slot.name,
				...blockedModels(now, applicable?.modelBlocks, storedModelBlocks(slot)),
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
			...(slotHealth(applicable, now) === "blocked"
				? describedBlock(applicable?.blockReason, applicable?.blockedUntil)
				: {}),
			pinned: pinned === slot.name,
			...blockedModels(now, applicable?.modelBlocks),
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
/**
 * Moves the material of a just-committed login (`loginName`) onto an existing account (`name`), so a
 * re-login keeps the account's id, display name and pin (senpi#3216). The new material gives the
 * account a new credential revision, which clears any block it carried. One store write; the
 * temporary login slot is gone afterwards.
 */
export async function replaceCredentialAccountMaterial(
	storage: AuthStorage,
	provider: string,
	name: string,
	loginName: string,
	repository?: CredentialSlotRepository,
): Promise<void> {
	if (loginName === name) return;
	await storage.modify(provider, async (current) => {
		if (current === undefined) throw new Error(`No stored credential for provider: ${provider}`);
		return replaceSlotMaterial(current as PooledCredential, name, loginName);
	});
	const repo = repository ?? defaultRepository(storage);
	await repo.mutateSlotState(provider, "stored", loginName, () => undefined);
	// New material starts with a clean record: no block, no failure streak, no model blocks.
	await repo.mutateSlotState(provider, "stored", name, () => undefined);
	emitProviderAccountsChanged(provider);
}

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
