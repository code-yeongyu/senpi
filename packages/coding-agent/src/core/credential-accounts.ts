import { dirname, join } from "node:path";
import { type Credential, normalizeProviderId } from "@earendil-works/pi-ai";
import { slotsOfOwnKind } from "@earendil-works/pi-ai/auth/pool/kinds";
import { applyAccountOrder, withoutOrderedAccount } from "@earendil-works/pi-ai/auth/pool/select";
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
import { type ModelBlocks, pruneModelBlocks } from "./credential-pool/model-scope.ts";
import { CredentialSlotRepository, type CredentialSlotState, slotHealth } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/anthropic-subscription/account-events.ts";
import { SENTINEL_OAUTH_FIELDS } from "./extensions/builtin/anthropic-subscription/accounts.ts";

export type CredentialAccountSource = "login" | "import" | "env";

/**
 * Why a blocked account sits out (senpi#4327): `auth_error` means the key was rejected and is skipped
 * until its re-probe time, `rate_limit` is a cooldown, `disabled` lasts until the credential is replaced.
 */
export type CredentialAccountBlockedReason = "auth_error" | "rate_limit" | "disabled";

/** Account metadata safe to surface: names and health only, never key material. */
export type CredentialAccountSummary = {
	readonly name: string;
	readonly displayName?: string;
	readonly source: CredentialAccountSource;
	readonly blocked: boolean;
	/** Present only while `blocked`; absent when the stored block names no reason. */
	readonly blockedReason?: CredentialAccountBlockedReason;
	/** Epoch ms when the block lifts (the re-probe time for `auth_error`); absent for `disabled`. */
	readonly blockedUntil?: number;
	readonly pinned: boolean;
	/** Usage limits binding one model (family) while the account serves the rest (senpi#2555). */
	readonly blockedModels?: readonly { readonly model: string; readonly until: number }[];
	/** A slot of the other kind than the stored credential: kept, never used, cannot be pinned (senpi#3486). */
	readonly unused?: true;
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

export function credentialPoolRepository(storage: AuthStorage): CredentialSlotRepository {
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
type SlotBlock = Pick<CredentialAccountSummary, "blocked" | "blockedReason" | "blockedUntil">;

const UNBLOCKED: SlotBlock = { blocked: false };

function accountBlockedReason(reason: string | undefined): CredentialAccountBlockedReason | undefined {
	switch (reason) {
		case "auth_error":
		case "rate_limit":
			return reason;
		case "account_disabled":
			return "disabled";
		default:
			return undefined;
	}
}

/** A live block with its reason and, unless disabled, the time it lifts. */
function liveBlock(reason: string | undefined, blockedUntil: number | undefined, now: number): SlotBlock {
	const blockedReason = accountBlockedReason(reason);
	if (blockedReason === "disabled") return { blocked: true, blockedReason };
	if (blockedUntil === undefined || blockedUntil <= now) return UNBLOCKED;
	return { blocked: true, ...(blockedReason === undefined ? {} : { blockedReason }), blockedUntil };
}

function sidecarBlock(sidecar: CredentialSlotState | undefined, now: number): SlotBlock {
	if (slotHealth(sidecar, now) !== "blocked") return UNBLOCKED;
	return liveBlock(sidecar?.blockReason, sidecar?.blockedUntil, now);
}

function slotBlocked(slot: object, sidecar: CredentialSlotState | undefined, now: number): SlotBlock {
	const fromSidecar = sidecarBlock(sidecar, now);
	const fromSlot = liveBlock(stringField(slot, "blockReason"), numberField(slot, "blockedUntil"), now);
	// A disabled account outranks a timed block from the other source: it never lifts on its own.
	if (fromSlot.blockedReason === "disabled") return fromSlot;
	if (fromSidecar.blockedReason === "disabled" || !fromSlot.blocked) return fromSidecar;
	if (!fromSidecar.blocked) return fromSlot;
	// Both sources hold a timed block: the account is usable only once the later one lifts, and a
	// rejected key stays the reason so a client still skips it.
	const later = (fromSlot.blockedUntil ?? 0) > (fromSidecar.blockedUntil ?? 0) ? fromSlot : fromSidecar;
	const rejected = [fromSidecar, fromSlot].some((block) => block.blockedReason === "auth_error");
	return rejected ? { ...later, blockedReason: "auth_error" } : later;
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
	return summarizeCredentialAccounts(
		provider,
		storage.get(provider),
		env,
		repository ?? credentialPoolRepository(storage),
	);
}

/** Storage-free variant for callers that already hold the credential (e.g. auth check). */
export async function summarizeCredentialAccounts(
	provider: string,
	stored: Credential | undefined,
	env: NodeJS.ProcessEnv = process.env,
	repository: CredentialSlotRepository = new CredentialSlotRepository(),
): Promise<CredentialAccountSummary[]> {
	const credential = pooledFrom(stored);
	return applyAccountOrder(credential?.order, await summarizeInStoredOrder(provider, credential, env, repository));
}

async function summarizeInStoredOrder(
	provider: string,
	credential: PooledCredential | undefined,
	env: NodeJS.ProcessEnv,
	repository: CredentialSlotRepository,
): Promise<CredentialAccountSummary[]> {
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
		const usable = new Set(slotsOfOwnKind(credential).map((slot) => slot.name));
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
				...slotBlocked(slot, applicable, now),
				pinned: pinned === slot.name,
				...blockedModels(now, applicable?.modelBlocks, storedModelBlocks(slot)),
				...(usable.has(slot.name) ? {} : { unused: true as const }),
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
			...sidecarBlock(applicable, now),
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
	const repo = repository ?? credentialPoolRepository(storage);
	if (name !== null) {
		assertValidAccountName(name);
		const accounts = await getCredentialAccounts(storage, provider, env, repo);
		const account = accounts.find((candidate) => candidate.name === name);
		if (!account) {
			throw new Error(`Provider account not found: ${name}`);
		}
		if (account.unused) {
			throw new Error(
				`Account ${name} holds a login of the other kind and is never used, so it cannot be pinned. To switch ${provider} to it, save it again with /login.`,
			);
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
	const repo = repository ?? credentialPoolRepository(storage);
	const accounts = await getCredentialAccounts(storage, provider, env, repo);
	const account = accounts.find((candidate) => candidate.name === name);
	if (!account) throw new Error(`Provider account not found: ${name}`);
	if (account.source === "env") {
		throw new Error(`Environment provider account cannot be removed: ${name}`);
	}
	const next = await storage.read(provider);
	if (next === undefined) throw new Error(`No stored credential for provider: ${provider}`);
	const removed = removeSlot(next, name);
	const remaining = removed === undefined ? undefined : withoutOrderedAccount(removed, name);
	if (remaining === undefined) await storage.delete(provider);
	else await storage.modify(provider, async () => remaining);
	await repo.mutateSlotState(provider, "stored", name, () => undefined);
	emitProviderAccountsChanged(provider);
}
