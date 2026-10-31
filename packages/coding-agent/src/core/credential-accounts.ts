import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Credential, normalizeProviderId } from "@earendil-works/pi-ai";
import { slotsOfOwnKind } from "@earendil-works/pi-ai/auth/pool/kinds";
import { applyAccountOrder, isSlotBlocked, withoutOrderedAccount } from "@earendil-works/pi-ai/auth/pool/select";
import {
	accountDisplayName,
	listSlots,
	type PooledCredential,
	pinSlot,
	removeSlot,
	renameSlotDisplayName,
} from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import { getAgentDir } from "../config.ts";
import { discoverEnvSlots } from "./credential-pool/env-slots.ts";
import { isAvailable } from "./credential-pool/failover.ts";
import { type ModelBlocks, pruneModelBlocks } from "./credential-pool/model-scope.ts";
import { CredentialSlotRepository, type CredentialSlotState } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/anthropic-subscription/account-events.ts";
import { isListedStoredSlot, SENTINEL_OAUTH_FIELDS } from "./extensions/builtin/anthropic-subscription/accounts.ts";
import { isAccountBlocked } from "./extensions/builtin/anthropic-subscription/affinity.ts";
import {
	accountDirFor,
	isValidAccountDirId,
	removeAccountDir,
} from "./extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import {
	defaultExecutableDeps,
	resolveClaudeCodeExecutable,
} from "./extensions/builtin/anthropic-subscription/executable.ts";

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
	/** Set for an account signed in through the bundled `claude` CLI, whose own store holds the login (senpi#4436). */
	readonly store?: "claude-cli";
	readonly signedInAt?: number;
	/** Local-only profile fields of a `claude-cli` account; never logged or sent to telemetry. */
	readonly email?: string;
	readonly orgName?: string;
	readonly subscriptionType?: string;
	/** The sign-in connection test's last result. */
	readonly check?: CredentialAccountCheck;
	readonly signIn?: "signed_in" | "needs_sign_in";
};

export type CredentialAccountCheck = {
	readonly model: string;
	readonly outcome: "ok" | "failed";
	readonly reason?: string;
	readonly at: number;
};

type ClaudeCliSlotFields = Pick<
	CredentialAccountSummary,
	"store" | "signedInAt" | "email" | "orgName" | "subscriptionType" | "check" | "signIn"
>;

function objectField(value: object, key: string): object | undefined {
	const found = Object.entries(value).find(([candidate]) => candidate === key)?.[1];
	return typeof found === "object" && found !== null && !Array.isArray(found) ? found : undefined;
}

function storedCheck(slot: object): CredentialAccountCheck | undefined {
	const check = objectField(slot, "check");
	if (check === undefined) return undefined;
	const model = stringField(check, "model");
	const outcome = stringField(check, "outcome");
	const at = numberField(check, "at");
	if (model === undefined || at === undefined || (outcome !== "ok" && outcome !== "failed")) return undefined;
	const reason = stringField(check, "reason");
	return { model, outcome, ...(reason === undefined ? {} : { reason }), at };
}

/** The listing fields of a stored `claude-cli` slot, read defensively: auth.json is a trust boundary. */
function claudeCliSlotFields(slot: object): ClaudeCliSlotFields {
	if (stringField(slot, "store") !== "claude-cli") return {};
	const profile = objectField(slot, "profile") ?? {};
	const signedInAt = numberField(slot, "signedInAt");
	const email = stringField(profile, "email");
	const orgName = stringField(profile, "orgName");
	const subscriptionType = stringField(profile, "subscriptionType");
	const check = storedCheck(slot);
	return {
		store: "claude-cli",
		...(signedInAt === undefined ? {} : { signedInAt }),
		...(email === undefined ? {} : { email }),
		...(orgName === undefined ? {} : { orgName }),
		...(subscriptionType === undefined ? {} : { subscriptionType }),
		...(check === undefined ? {} : { check }),
		signIn: stringField(slot, "signInRequired") === undefined ? "signed_in" : "needs_sign_in",
	};
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

export function credentialPoolRepository(storage: AuthStorage): CredentialSlotRepository {
	const authPath = storage.getStoragePath();
	return new CredentialSlotRepository(authPath ? join(dirname(authPath), "credential-pool-state.json") : undefined);
}

function stringField(value: object, key: string): string | undefined {
	const found = Object.entries(value).find(([candidate]) => candidate === key)?.[1];
	return typeof found === "string" ? found : undefined;
}

/**
 * Cursor and Claude persist their lane's blocks in auth.json. Generic pool
 * rotation ignores those fields and reads revision-matched sidecar health.
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
	if (sidecar === undefined || isAvailable(sidecar, now)) return UNBLOCKED;
	return liveBlock(sidecar?.blockReason, sidecar?.blockedUntil, now);
}

/**
 * A block a provider lane stored on its own slot holds exactly while that lane's selector skips the slot, so a
 * listing never calls a skipped account available (senpi#4365 follow-up). The Claude lane re-probes an auth block
 * whose deadline passed; the Cursor lane keeps one until re-login, with no deadline to report.
 */
function storedSlotBlock(provider: string, slot: object, now: number): SlotBlock {
	const blockReason = stringField(slot, "blockReason");
	const blockedUntil = numberField(slot, "blockedUntil");
	const blockedReason = accountBlockedReason(blockReason);
	if (blockedReason === "disabled") return { blocked: true, blockedReason };
	const skipped =
		normalizeProviderId(provider) === "anthropic-subscription"
			? isAccountBlocked({ blockedUntil }, now)
			: isSlotBlocked({ blockReason, blockedUntil }, now);
	if (!skipped) return UNBLOCKED;
	return {
		blocked: true,
		...(blockedReason === undefined ? {} : { blockedReason }),
		...(blockedUntil === undefined || blockedUntil <= now ? {} : { blockedUntil }),
	};
}

function slotBlocked(provider: string, slot: object, sidecar: CredentialSlotState | undefined, now: number): SlotBlock {
	const fromSidecar = sidecarBlock(sidecar, now);
	const lane = normalizeProviderId(provider);
	// rotation-slots overlays only sidecar health; generic failover never sees auth.json block fields.
	if (lane !== "cursor-cli-oauth" && lane !== "anthropic-subscription") return fromSidecar;
	const fromSlot = storedSlotBlock(provider, slot, now);
	// A disabled account outranks a timed block from the other source: it never lifts on its own.
	if (fromSlot.blockedReason === "disabled") return fromSlot;
	if (fromSidecar.blockedReason === "disabled" || !fromSlot.blocked) return fromSidecar;
	// So does a stored block with no deadline: only a re-login lifts it, so no expiry may be borrowed for it.
	if (!fromSidecar.blocked || fromSlot.blockedUntil === undefined) return fromSlot;
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
		const isClaudeSubscription = normalizeProviderId(provider) === "anthropic-subscription";
		// The Claude lane's own listing rule, so both listings show the same accounts (senpi#4436).
		const storedAccounts = isClaudeSubscription
			? Array.isArray(credential.accounts)
				? listSlots(credential).filter(isListedStoredSlot)
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
				...slotBlocked(provider, slot, applicable, now),
				pinned: pinned === slot.name,
				...blockedModels(now, applicable?.modelBlocks, storedModelBlocks(slot)),
				...(usable.has(slot.name) ? {} : { unused: true as const }),
				...(isClaudeSubscription ? claudeCliSlotFields(slot) : {}),
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
): Promise<RemoveCredentialAccountResult> {
	const repo = repository ?? credentialPoolRepository(storage);
	const accounts = await getCredentialAccounts(storage, provider, env, repo);
	const account = accounts.find((candidate) => candidate.name === name);
	if (!account) throw new Error(`Provider account not found: ${name}`);
	if (account.source === "env") {
		throw new Error(`Environment provider account cannot be removed: ${name}`);
	}
	const notice = await signOutAndDropSlot(storage, provider, name, env, repo);
	emitProviderAccountsChanged(provider);
	return notice === undefined ? {} : { notice };
}

/** Drops one stored slot with its pin, order entry and pool sidecar state, from the credential as stored now. */
async function dropStoredSlot(
	storage: AuthStorage,
	provider: string,
	name: string,
	repo: CredentialSlotRepository,
): Promise<void> {
	const removed = removeSlot(await storage.read(provider), name);
	const remaining = removed === undefined ? undefined : withoutOrderedAccount(removed, name);
	if (remaining === undefined) await storage.delete(provider);
	else await storage.modify(provider, async () => remaining);
	await repo.mutateSlotState(provider, "stored", name, () => undefined);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The one CLI-safe removal of a stored slot, shared by every entry point (senpi#4436): an Anthropic Subscription
 * `claude-cli` slot is signed out and its dir removed first, then the slot is dropped. When the sign-out throws
 * (an abort, a filesystem error), the slot is kept with its dir, unless the dir was already removed, in which case
 * the slot is dropped too. If the drop itself then fails, the slot stays stored without its dir until the next
 * removal of it, which finds the dir gone and drops the slot.
 */
async function signOutAndDropSlot(
	storage: AuthStorage,
	provider: string,
	name: string,
	env: NodeJS.ProcessEnv,
	repo: CredentialSlotRepository,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const credential = await storage.read(provider);
	if (credential === undefined) throw new Error(`No stored credential for provider: ${provider}`);
	let notice: string | undefined;
	if (normalizeProviderId(provider) === "anthropic-subscription") {
		const accountDir = claudeCliAccountDir(storage, credential, name);
		const dirExisted = accountDir !== undefined && (await pathExists(accountDir));
		try {
			notice = await signOutClaudeCliSlot(storage, credential, name, env, signal);
		} catch (error) {
			if (dirExisted && !(await pathExists(accountDir))) await dropStoredSlot(storage, provider, name, repo);
			throw error;
		}
	}
	await dropStoredSlot(storage, provider, name, repo);
	return notice;
}

/**
 * A provider logout deletes every stored account at once. For Anthropic Subscription each `claude-cli` slot is first
 * signed out of the CLI's own store by its account dir, through the same per-slot path as a single removal (link
 * guard, never stuck on the CLI), so a logout never orphans a CLI sign-in (senpi#4436). Returns the notices of the
 * slots that could not be signed out cleanly; any other provider returns none.
 */
export async function signOutClaudeCliSlotsForLogout(
	storage: AuthStorage,
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<readonly string[]> {
	if (normalizeProviderId(provider) !== "anthropic-subscription") return [];
	const credential = await storage.read(provider);
	if (credential === undefined) return [];
	const repo = credentialPoolRepository(storage);
	const notices: string[] = [];
	let dropped = false;
	try {
		// Each account is dropped from the store as soon as it is signed out, so an abort or a failure on a later
		// account never leaves an earlier one stored without its dir.
		for (const slot of listSlots(credential)) {
			if (stringField(slot, "store") !== "claude-cli") continue;
			signal?.throwIfAborted();
			const notice = await signOutAndDropSlot(storage, provider, slot.name, env, repo, signal);
			dropped = true;
			if (notice !== undefined) notices.push(notice);
		}
	} finally {
		if (dropped) emitProviderAccountsChanged(provider);
	}
	return notices;
}

/** `notice`: the account was removed, but something about it could not be cleaned up and the user should know. */
export type RemoveCredentialAccountResult = { readonly notice?: string };

/** The agent dir the account dirs live under: the auth file's dir, else the default agent dir. */
function claudeCliAgentDir(storage: AuthStorage): string {
	const authPath = storage.getStoragePath();
	return authPath ? dirname(authPath) : getAgentDir();
}

/** The account dir of a `claude-cli` slot with a valid dir id; undefined for any other slot. */
function claudeCliAccountDir(storage: AuthStorage, credential: Credential, name: string): string | undefined {
	const slot = listSlots(credential).find((candidate) => candidate.name === name);
	if (slot === undefined || stringField(slot, "store") !== "claude-cli") return undefined;
	const dirId = stringField(slot, "dirId");
	return dirId !== undefined && isValidAccountDirId(dirId)
		? accountDirFor(claudeCliAgentDir(storage), dirId)
		: undefined;
}

/**
 * A `claude-cli` slot is signed out of the CLI's own store and its account dir removed, so the caller
 * (`signOutAndDropSlot`) can drop the slot afterwards. Removal never gets stuck on the CLI: when `claude` cannot be
 * resolved or its sign-out fails, the dir is still removed, with a notice that the sign-out did not run. A slot that
 * names no valid account dir, or whose dir is a link or file, cannot be signed out safely; the caller drops it anyway
 * and the notice says so.
 */
async function signOutClaudeCliSlot(
	storage: AuthStorage,
	credential: Credential,
	name: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const slot = listSlots(credential).find((candidate) => candidate.name === name);
	if (slot === undefined || stringField(slot, "store") !== "claude-cli") return undefined;
	const dirId = stringField(slot, "dirId");
	const agentDir = claudeCliAgentDir(storage);
	if (dirId === undefined || !isValidAccountDirId(dirId)) {
		return `Removed Claude account ${name} without a Claude sign-out: it names no valid account dir.`;
	}
	let executable: string | undefined;
	try {
		executable = resolveClaudeCodeExecutable({ ...defaultExecutableDeps(), env: (key) => env[key] });
	} catch {
		executable = undefined;
	}
	const outcome = await removeAccountDir({
		agentDir,
		dirId,
		executable,
		parentEnv: env,
		...(signal === undefined ? {} : { signal }),
	});
	if (outcome === "removed") return undefined;
	if (outcome === "removed_without_sign_out") {
		return `Removed Claude account ${name}, but the Claude CLI sign-out could not run; its stored sign-in may remain in the Claude CLI's credential store.`;
	}
	return `Removed Claude account ${name} without a Claude sign-out: its account dir is a link or a file, left untouched at ${accountDirFor(agentDir, dirId)}.`;
}
