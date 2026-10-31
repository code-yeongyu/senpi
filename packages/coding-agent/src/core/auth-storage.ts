/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */

import type {
	ApiKeyCredential,
	AuthEvent,
	AuthInteraction,
	AuthOperationOptions,
	AuthPrompt,
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { findEnvKeys, getEnvApiKey, readByProviderId } from "@earendil-works/pi-ai";
import { type CredentialKind, slotKind, unusedSlotKinds } from "@earendil-works/pi-ai/auth/pool/kinds";
import {
	appendLoginSlot,
	type CredentialSlot,
	listSlots,
	type PooledCredential,
	projectSlot,
	removeSlot,
	repairManagedSentinelSlots,
	upsertSlot,
} from "@earendil-works/pi-ai/auth/pool/slots";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { getFileContentRevision, normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { signOutLegacyClaudeLogins } from "./anthropic-legacy-sign-out.ts";
import {
	resolveReadOnlyCredential,
	resolveStoredCredential,
	resolveStoredSlot,
	validateReadOnlyAuthData,
} from "./auth-credential-values.ts";
import { migrateLegacyProviderKeys } from "./auth-provider-key-migration.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./extensions/builtin/anthropic-subscription/provider-id.ts";
import type { AnthropicSubscriptionCredential } from "./extensions/builtin/anthropic-subscription/accounts.ts";
import { signInAgainMessage, signInRequiredNames } from "./extensions/builtin/anthropic-subscription/sign-in-again.ts";
import { lockWithLossHandling } from "./file-lock.ts";
import {
	CredentialStoreBusyError,
	FILE_STORAGE_LOCK_OPTIONS,
	FILE_STORAGE_LOCK_RETRY_BUDGET_MS,
	FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
	FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS,
	FILE_STORAGE_SYNC_LOCK_BUDGET_MS,
	isLockError,
} from "./lockfile-policy.ts";

type AuthStorageData = Record<string, Credential>;

/**
 * Heals pools poisoned by a shipped build that stored a provider-owned pool's
 * flat sentinel as a generated `login-N` slot. Such a slot resolves to sentinel
 * material, fails the provider's auth `check`, and hard-errors every request
 * whose affinity picks it - deterministically, for the lifetime of the entry -
 * so it is dropped the moment auth.json is read and the repair is written back
 * once by the mutable store.
 */
function repairPoisonedPoolSlots(data: AuthStorageData): { data: AuthStorageData; repaired: boolean } {
	let repaired: AuthStorageData | undefined;
	for (const [providerId, credential] of Object.entries(data)) {
		if (typeof credential !== "object" || credential === null) continue;
		const healed = repairManagedSentinelSlots(providerId, credential);
		if (!healed) continue;
		repaired ??= { ...data };
		repaired[providerId] = healed;
	}
	return repaired ? { data: repaired, repaired: true } : { data, repaired: false };
}

const KIND_LABEL: Readonly<Record<CredentialKind, string>> = { oauth: "OAuth login", api_key: "API key" };

/** A credential problem the user should see once per change: `id` changes when the problem does. */
export type AuthNotice = {
	readonly id: string;
	readonly provider: string;
	readonly message: string;
	/** Shown at every start while the problem lasts, instead of once per change. */
	readonly repeats?: boolean;
};

/**
 * One notice per provider whose stored credential holds slots its type cannot use (senpi#3448).
 * Nothing is changed: which credential pays stays the user's choice, so the notice names the
 * unused login, where it still is, and the action that switches to it.
 */
function unusedLoginNotices(data: AuthStorageData): AuthNotice[] {
	const notices: AuthNotice[] = [];
	for (const [provider, credential] of Object.entries(data)) {
		if (typeof credential !== "object" || credential === null) continue;
		for (const kind of unusedSlotKinds(credential)) {
			const slots = listSlots(credential).filter((slot) => slotKind(slot) === kind);
			const inUse = KIND_LABEL[credential.type];
			const names = slots.map((slot) => slot.name);
			notices.push({
				// Slot names, never key material: a new unused login gets a new id and is shown again.
				id: `${provider}:${kind}:${names.join(",")}`,
				provider,
				message: `${provider}: an ${KIND_LABEL[kind]} saved earlier is stored next to your ${inUse} but is never used; the ${inUse} stays in use. It is still in auth.json (${slots.map((slot) => slot.name).join(", ")}); to switch to it, save it again with /login (the ${inUse} is backed up first).`,
			});
		}
	}
	return notices;
}

/**
 * One notice, at every start, while Claude subscription accounts from the retired sign-in still need a sign-in again
 * (senpi#4436); it repeats until they are signed in again or removed, so it is never marked seen.
 */
function signInRequiredNotices(data: AuthStorageData): AuthNotice[] {
	const subscription = data[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID] as AnthropicSubscriptionCredential | undefined;
	const accounts = Array.isArray(subscription?.accounts) ? subscription.accounts : [];
	const names = signInRequiredNames(accounts);
	if (names.length === 0) return [];
	return [
		{
			id: `${ANTHROPIC_SUBSCRIPTION_PROVIDER_ID}:sign-in-required:${names.join(",")}`,
			provider: ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
			message: signInAgainMessage(names),
			repeats: true,
		},
	];
}

export type CredentialReplacement = { readonly replaced: CredentialKind; readonly backupPath?: string };

/** What a login that replaced a credential of the other kind tells the user (senpi#3448, #3486). */
export function describeCredentialReplacement(provider: string, replacement: CredentialReplacement): string {
	const where = replacement.backupPath ? ` It is saved in ${replacement.backupPath}` : " It was not backed up";
	return `Your ${KIND_LABEL[replacement.replaced]} for ${provider} was replaced by this login.${where}; to switch back, log in with it again.`;
}

export type AuthCredential = Credential;
export type { ApiKeyCredential, OAuthCredential };
export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export interface GetApiKeyOptions {
	includeFallback?: boolean;
}

type LockResult<T> = {
	result: T;
	next?: string;
};

// Every write stages a fresh 0o600 file and renames it over the store, so the
// credential file is never briefly world-readable and never half-written; the
// restrictive mode also wins over any wider mode an earlier direct write left.
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

type AuthFileReload = {
	controller: AbortController;
	promise: Promise<AuthStorageData>;
	readers: number;
};

type AuthFileReadState = {
	data: AuthStorageData;
	/** Set once a read succeeds; until then `data` is an empty placeholder, not the store. */
	loaded?: boolean;
	revision?: string;
	reload?: AuthFileReload;
};

let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

/**
 * Outcome of a synchronous store read. `busy` means the lock stayed held past the sync
 * budget, so the in-memory credentials are a fallback rather than the store's contents;
 * `failed` is any other read error (the last valid snapshot is kept, as before).
 */
export type AuthReloadResult = "loaded" | "busy" | "failed";

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
		}
	}

	/**
	 * Atomic credential write: stage a 0o600 temp file beside the store and
	 * rename it over the target. An existing store may carry an
	 * administrator-set mode; it is copied onto the temp before the rename, so
	 * preservation matches the previous in-place write (whose mode applied only
	 * on creation) and the staged bytes are never wider than the file already
	 * was. Cross-process writers are serialized by the proper-lockfile lock the
	 * caller already holds, so the pid-suffixed temp cannot collide; a crashed
	 * write leaves at worst a 0o600 temp behind.
	 */
	private writeAuthFile(content: string): void {
		const temporary = `${this.authPath}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, content, AUTH_FILE_WRITE_OPTIONS);
			if (existsSync(this.authPath)) {
				chmodSync(temporary, statSync(this.authPath).mode & 0o777);
			}
			renameSync(temporary, this.authPath);
		} catch (error) {
			try {
				rmSync(temporary, { force: true });
			} catch {
				// Best effort; a stale temp is already 0o600.
			}
			throw error;
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const startedAt = Date.now();
		let attempt = 0;
		while (true) {
			try {
				return lockfile.lockSync(path, { ...FILE_STORAGE_LOCK_OPTIONS, retries: 0 });
			} catch (error) {
				if (!isLockError(error)) throw error;
				const waitedMs = Date.now() - startedAt;
				if (waitedMs >= FILE_STORAGE_SYNC_LOCK_BUDGET_MS) {
					throw new CredentialStoreBusyError(path, waitedMs, error);
				}
				const delayMs = Math.min(
					FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS * 2 ** attempt,
					FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
					FILE_STORAGE_SYNC_LOCK_BUDGET_MS - waitedMs,
				);
				attempt++;
				const sleeper = new Int32Array(new SharedArrayBuffer(4));
				Atomics.wait(sleeper, 0, 0, delayMs);
			}
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				this.writeAuthFile(next);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	private async acquireLockAsync(
		signal: AbortSignal | undefined,
		onCompromised: (error: Error) => void,
	): Promise<() => Promise<void>> {
		signal?.throwIfAborted();
		const startedAt = Date.now();
		let attempt = 0;
		// The retry loop stays here rather than delegating to proper-lockfile's own
		// `retries`, so an abort is observed between attempts instead of after the
		// whole budget, and `onCompromised` is rebound per attempt.
		while (true) {
			try {
				const { release } = await lockWithLossHandling(this.authPath, {
					...FILE_STORAGE_LOCK_OPTIONS,
					retries: 0,
					onLost: onCompromised,
				});
				if (signal?.aborted) {
					await release();
					signal.throwIfAborted();
				}
				return release;
			} catch (error) {
				signal?.throwIfAborted();
				if (!isLockError(error)) throw error;
				const waitedMs = Date.now() - startedAt;
				if (waitedMs >= FILE_STORAGE_LOCK_RETRY_BUDGET_MS) {
					throw new CredentialStoreBusyError(this.authPath, waitedMs, error);
				}
				const delayMs = Math.min(
					FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS * 2 ** attempt,
					FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
					FILE_STORAGE_LOCK_RETRY_BUDGET_MS - waitedMs,
				);
				attempt++;
				await raceWithAbortSignal(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), signal);
			}
		}
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await this.acquireLockAsync(options?.signal, (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			});

			throwIfCompromised();
			options?.signal?.throwIfAborted();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.writeAuthFile(next);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class ReadOnlyAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private data: AuthStorageData | undefined;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private load(): AuthStorageData {
		if (this.data) return this.data;

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(readFileSync(this.authPath, "utf-8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.data = {};
				return this.data;
			}
			throw new Error(`Failed to read auth.json: ${error instanceof Error ? error.message : String(error)}`);
		}

		validateReadOnlyAuthData(parsed);

		this.data = repairPoisonedPoolSlots(parsed as AuthStorageData).data;
		return this.data;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		// Read boundary (senpi#1989): an auth.json written by an earlier version is
		// keyed by the legacy provider id. Try the canonical key first, then the
		// legacy spelling, so a credential is never reported missing after the
		// rename. Nothing is rewritten here.
		const credential = readByProviderId(this.load(), providerId);
		options?.signal?.throwIfAborted();
		return resolveReadOnlyCredential(credential, providerId, this.authPath);
	}

	async readSlot(
		providerId: string,
		slotName: string,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = readByProviderId(this.load(), providerId);
		options?.signal?.throwIfAborted();
		return resolveStoredSlot(credential, { providerId, slotName, authPath: this.authPath }, (flat) =>
			resolveReadOnlyCredential(flat, providerId, this.authPath),
		);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = Object.entries(this.load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
		options?.signal?.throwIfAborted();
		return credentials;
	}

	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<unknown> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const previous = this.asyncChain;
		const operation = (async () => {
			await previous.catch(() => {});
			options?.signal?.throwIfAborted();
			const { result, next } = await fn(this.value);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		})();
		this.asyncChain = operation.catch(() => {});
		return raceWithAbortSignal(operation, options?.signal);
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage implements CredentialStore {
	private data: AuthStorageData = {};
	private readonly runtimeOverrides = new Map<string, string>();
	private readonly extensionOAuthProviders = new Map<string, OAuthAuth>();
	private errors: Error[] = [];
	private readonly reportedMigrationSkips = new Set<string>();
	private notices: AuthNotice[] = [];
	private readonly seenInMemory = new Set<string>();
	private readonly takenNotices = new Set<string>();
	private readonly replacements = new Map<string, CredentialReplacement>();
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	private readState: AuthFileReadState;
	private busyReads = 0;
	private dataLoaded = false;
	private dataFromBusyRead = false;

	private constructor(storage: AuthStorageBackend, authPath?: string) {
		this.storage = storage;
		this.authPath = authPath;
		this.readState =
			authPath && sharedAuthFileReadState?.authPath === authPath ? sharedAuthFileReadState.readState : { data: {} };
		if (authPath && !sharedAuthFileReadState) {
			sharedAuthFileReadState = { authPath, readState: this.readState };
		}
		if (authPath && this.readState.loaded) {
			// Another instance already loaded this store: start from its credentials, not an
			// empty snapshot, so a busy read below keeps them. A repaired or migrated load
			// leaves the revision unset, so only an exact revision match skips the re-read.
			this.data = this.readState.data;
			this.dataLoaded = true;
			const revision = getFileContentRevision(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath);
	}

	getStoragePath(): string | undefined {
		return this.authPath;
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) return {};
		// Mutation paths keep the stored keys as-is: the key migration (and its
		// pre-write backup) belongs to the load seam, so a write can never drop a
		// legacy entry without the backup that preserves it.
		return repairPoisonedPoolSlots(JSON.parse(stripBom(content)) as AuthStorageData).data;
	}

	/**
	 * Reports whether the parse healed poisoned pool slots or moved legacy
	 * provider keys, so a load can write the result back exactly once. Repair
	 * runs FIRST, while the entry still sits under its legacy key, so poisoned
	 * sentinel slots heal with old-key derivation semantics; the sentinel
	 * matcher accepts legacy materials too, so a later load of an already
	 * migrated credential heals the same way.
	 */
	private parseStorageContent(content: string | undefined): {
		data: AuthStorageData;
		repaired: boolean;
		migrated: boolean;
	} {
		if (!content) {
			return { data: {}, repaired: false, migrated: false };
		}
		const repaired = repairPoisonedPoolSlots(JSON.parse(stripBom(content)) as AuthStorageData);
		const migrated = migrateLegacyProviderKeys(repaired.data);
		const moved = signOutLegacyClaudeLogins(migrated.data);
		if (moved.skipped && !this.reportedMigrationSkips.has(moved.skipped)) {
			this.reportedMigrationSkips.add(moved.skipped);
			this.recordError(
				new Error(
					`A Claude login in auth.json was left unchanged because ${moved.skipped}. Claude logins from the old sign-in are no longer used; sign in again with Claude: run /login anthropic-subscription.`,
				),
			);
		}
		this.notices = [...unusedLoginNotices(moved.data), ...signInRequiredNotices(moved.data)];
		return {
			data: moved.data,
			repaired: repaired.repaired,
			migrated: migrated.migrated || moved.migrated,
		};
	}

	private recordError(error: unknown): void {
		this.errors.push(error instanceof Error ? error : new Error(String(error)));
	}

	/**
	 * Timestamped 0o600 copy of the pre-migration bytes, written inside the
	 * held store lock before the migrated document replaces them. A migration
	 * re-run after a crash between backup and rewrite writes another backup;
	 * the loop suffix keeps same-millisecond names from overwriting each other.
	 */
	private backupAuthFile(content: string | undefined): string | undefined {
		if (!this.authPath || content === undefined) return undefined;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		let backupPath = `${this.authPath}.backup-${stamp}`;
		for (let attempt = 1; existsSync(backupPath); attempt++) {
			backupPath = `${this.authPath}.backup-${stamp}-${attempt}`;
		}
		writeFileSync(backupPath, content, AUTH_FILE_WRITE_OPTIONS);
		return backupPath;
	}

	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.data = data;
		this.dataLoaded = true;
		this.dataFromBusyRead = false;
		this.readState.data = data;
		this.readState.loaded = true;
		this.readState.revision = revision;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): AuthReloadResult {
		let data: AuthStorageData = {};
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				const parsed = this.parseStorageContent(current);
				data = parsed.data;
				// A written repair or migration invalidates the revision read before
				// it; leaving it unset makes the next reader re-read instead of
				// trusting a stale stamp.
				revision =
					parsed.repaired || parsed.migrated || !this.authPath ? undefined : getFileContentRevision(this.authPath);
				if (parsed.migrated) this.backupAuthFile(current);
				return parsed.repaired || parsed.migrated
					? { result: undefined, next: JSON.stringify(parsed.data, null, 2) }
					: { result: undefined };
			});
			this.updateReadState(data, revision);
			return "loaded";
		} catch (error) {
			// Preserve the last valid in-memory snapshot.
			this.recordError(error instanceof Error ? error : new Error(String(error)));
			if (!(error instanceof CredentialStoreBusyError)) return "failed";
			if (!this.dataLoaded) {
				this.busyReads++;
				this.dataFromBusyRead = true;
			}
			return "busy";
		}
	}

	/**
	 * True while the store has never loaded because every read found it locked, so the
	 * in-memory credentials are an empty placeholder; `reload()` retries. A readable empty
	 * store, or a busy read after a successful load, is not busy.
	 */
	isCredentialStoreBusy(): boolean {
		return this.dataFromBusyRead;
	}

	/**
	 * Monotonic count of reads (sync or async) that found the store locked before it ever
	 * loaded and answered with the empty placeholder. A change across an operation means
	 * its credentials do not reflect the store.
	 */
	getBusyReadCount(): number {
		return this.busyReads;
	}

	private noteBusyFallback(error: unknown): void {
		if (error instanceof CredentialStoreBusyError && !this.readState.loaded) this.busyReads++;
	}

	/** Set a non-persistent API key used ahead of stored credentials. */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	get(provider: string): Credential | undefined {
		return readByProviderId(this.data, provider);
	}

	getProviderEnv(provider: string): Record<string, string> | undefined {
		const credential = readByProviderId(this.data, provider);
		return credential?.type === "api_key" && credential.env ? { ...credential.env } : undefined;
	}

	/**
	 * Stores a login. A login of the other kind replaces the provider's credential (senpi#3448); the
	 * previous bytes are backed up first, and the replacement is returned and kept for
	 * `takeReplacement`, so no credential disappears without the user being told where it went.
	 */
	set(provider: string, credential: Credential): CredentialReplacement | undefined {
		return this.storage.withLock((content) => {
			const currentData = this.parseStorageData(content);
			const replacement = this.noteReplacement(provider, currentData[provider], credential, content);
			const next = appendLoginSlot(currentData[provider], credential);
			const nextData = { ...currentData, [provider]: next };
			this.data = nextData;
			return { result: replacement, next: JSON.stringify(nextData, null, 2) };
		});
	}

	/** The last replacement a login made for this provider, once; the caller shows it to the user. */
	takeReplacement(provider: string): CredentialReplacement | undefined {
		const replacement = this.replacements.get(provider);
		this.replacements.delete(provider);
		return replacement;
	}

	/** Credential notices not yet marked seen; a changed problem gets a new id and shows again. */
	pendingNotices(): ReadonlyArray<AuthNotice> {
		const seen = this.seenNoticeIds();
		return this.notices.filter((notice) => notice.repeats === true || !seen.has(notice.id));
	}

	/**
	 * Hands out each pending notice once per process, so a run that reports auth problems at several
	 * points shows it once (senpi#3486). With `persistSeen`, the notices are also recorded as seen, so
	 * the next launch stays quiet until the problem changes; a run nobody reads (RPC) leaves them pending.
	 */
	takePendingNotices(options: { persistSeen: boolean }): ReadonlyArray<AuthNotice> {
		const taken = this.pendingNotices().filter((notice) => !this.takenNotices.has(notice.id));
		for (const notice of taken) this.takenNotices.add(notice.id);
		if (options.persistSeen) this.markNoticesSeen(taken.map((notice) => notice.id));
		return taken;
	}

	/**
	 * Records notices as shown, so the next launch stays quiet until the problem changes. Ids of
	 * problems that no longer exist are dropped. A failed write never aborts startup: it is reported,
	 * and the notice may be shown once more.
	 */
	markNoticesSeen(ids: readonly string[]): void {
		if (ids.length === 0) return;
		const path = this.seenNoticesPath();
		if (!path) {
			for (const id of ids) this.seenInMemory.add(id);
			return;
		}
		const current = new Set(this.notices.map((notice) => notice.id));
		const seen = [...new Set([...this.seenNoticeIds(), ...ids])].filter((id) => current.has(id));
		try {
			writeFileSync(path, JSON.stringify(seen, null, 2), AUTH_FILE_WRITE_OPTIONS);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.recordError(
				new Error(
					`Could not record which credential notices were shown (${path}): ${reason}. They may be shown again on the next start; check that the file is writable.`,
				),
			);
		}
	}

	private seenNoticesPath(): string | undefined {
		return this.authPath ? join(dirname(this.authPath), "auth-notices-seen.json") : undefined;
	}

	private seenNoticeIds(): Set<string> {
		const path = this.seenNoticesPath();
		if (!path) return new Set(this.seenInMemory);
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
		} catch {
			return new Set();
		}
	}

	private noteReplacement(
		provider: string,
		previous: Credential | undefined,
		next: Credential,
		content: string | undefined,
	): CredentialReplacement | undefined {
		if (previous === undefined || previous.type === next.type) return undefined;
		const backupPath = this.backupAuthFile(content);
		const replacement: CredentialReplacement = backupPath
			? { replaced: previous.type, backupPath }
			: { replaced: previous.type };
		this.replacements.set(provider, replacement);
		return replacement;
	}

	remove(provider: string): void {
		this.storage.withLock((content) => {
			const nextData = { ...this.parseStorageData(content) };
			delete nextData[provider];
			this.data = nextData;
			return { result: undefined, next: JSON.stringify(nextData, null, 2) };
		});
	}

	listSlots(provider: string): CredentialSlot[] {
		return listSlots(readByProviderId(this.data, provider) as PooledCredential | undefined);
	}

	setSlot(provider: string, slot: CredentialSlot): void {
		this.storage.withLock((content) => {
			const currentData = this.parseStorageData(content);
			const next = upsertSlot(currentData[provider] as PooledCredential | undefined, slot);
			const nextData = { ...currentData, [provider]: next };
			this.data = nextData;
			return { result: undefined, next: JSON.stringify(nextData, null, 2) };
		});
	}

	removeSlot(provider: string, name: string): void {
		this.storage.withLock((content) => {
			const currentData = this.parseStorageData(content);
			const next = removeSlot(currentData[provider] as PooledCredential | undefined, name);
			const nextData = { ...currentData };
			if (next === undefined) delete nextData[provider];
			else nextData[provider] = next;
			this.data = nextData;
			return { result: undefined, next: JSON.stringify(nextData, null, 2) };
		});
	}

	has(provider: string): boolean {
		return provider in this.data;
	}

	hasAuth(provider: string): boolean {
		return this.runtimeOverrides.has(provider) || this.has(provider) || getEnvApiKey(provider) !== undefined;
	}

	getAuthStatus(provider: string): AuthStatus {
		if (this.has(provider)) return { configured: true, source: "stored" };
		if (this.runtimeOverrides.has(provider)) return { configured: true, source: "runtime", label: "--api-key" };
		const envName = findEnvKeys(provider)?.[0];
		if (envName && process.env[envName]) return { configured: true, source: "environment", label: envName };
		return { configured: false };
	}

	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const errors = this.errors;
		this.errors = [];
		return errors;
	}

	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const parsed = this.parseStorageContent(content);
			const revision =
				parsed.repaired || parsed.migrated || !this.authPath ? undefined : getFileContentRevision(this.authPath);
			this.updateReadState(parsed.data, revision);
			if (parsed.migrated) this.backupAuthFile(content);
			return parsed.repaired || parsed.migrated
				? { result: parsed.data, next: JSON.stringify(parsed.data, null, 2) }
				: { result: parsed.data };
		}, options);
	}

	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		options?.signal?.throwIfAborted();
		if (!this.authPath) {
			try {
				return await this.reloadFromStorageAsync(options);
			} catch (error) {
				options?.signal?.throwIfAborted();
				this.recordError(error);
				this.noteBusyFallback(error);
				return this.readState.data;
			}
		}
		const revision = getFileContentRevision(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		if (!this.readState.reload) {
			const controller = new AbortController();
			const reload: AuthFileReload = {
				controller,
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				readers: 0,
			};
			this.readState.reload = reload;
			void reload.promise.then(
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				(error: unknown) => {
					if (!controller.signal.aborted) this.recordError(error);
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		const reload = this.readState.reload;
		reload.readers++;
		try {
			try {
				return await raceWithAbortSignal(reload.promise, options?.signal);
			} catch (error) {
				options?.signal?.throwIfAborted();
				this.noteBusyFallback(error);
				return this.readState.data;
			}
		} finally {
			reload.readers--;
			if (reload.readers === 0 && this.readState.reload === reload) {
				this.readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const runtimeKey = this.runtimeOverrides.get(provider);
		if (runtimeKey) return { type: "api_key", key: runtimeKey };
		const credential = (await this.readLatestData(options))[provider];
		options?.signal?.throwIfAborted();
		return resolveStoredCredential(credential, provider, this.authPath);
	}

	async readSlot(provider: string, slotName: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const runtimeKey = this.runtimeOverrides.get(provider);
		if (runtimeKey) return projectSlot({ type: "api_key", key: runtimeKey }, slotName);
		const credential = (await this.readLatestData(options))[provider];
		options?.signal?.throwIfAborted();
		return resolveStoredSlot(credential, { providerId: provider, slotName, authPath: this.authPath }, (flat) =>
			resolveStoredCredential(flat, provider, this.authPath),
		);
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const next = await fn(currentData[provider]);
			if (next === undefined) {
				latestData = currentData;
				revision = this.authPath ? getFileContentRevision(this.authPath) : undefined;
				return { result: currentData[provider] };
			}

			this.noteReplacement(provider, currentData[provider], next, content);
			const merged: AuthStorageData = { ...currentData, [provider]: next };
			latestData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);
		this.updateReadState(latestData, revision);
		return result;
	}

	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.runtimeOverrides.delete(provider);
		let latestData = this.readState.data;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		this.updateReadState(latestData);
	}

	/** List credential metadata without resolving configured key values. */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map(
			Object.entries(await this.readLatestData(options)).map(([providerId, credential]) => [
				providerId,
				{ providerId, type: credential.type },
			]),
		);
		options?.signal?.throwIfAborted();
		for (const providerId of this.runtimeOverrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	async getApiKey(providerId: string, options: GetApiKeyOptions = {}): Promise<string | undefined> {
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) return runtimeKey;
		const credential = await this.read(providerId);
		if (credential?.type === "api_key") return credential.key;
		if (credential?.type === "oauth") {
			const oauth = builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
			if (!oauth) return undefined;
			let current = credential;
			if (Date.now() >= current.expires) {
				const refreshed = await this.modify(providerId, async (stored) => {
					if (stored?.type !== "oauth") return stored;
					return Date.now() < stored.expires ? stored : oauth.refresh(stored, new AbortController().signal);
				});
				if (refreshed?.type !== "oauth") return undefined;
				current = refreshed;
			}
			return (await oauth.toAuth(current)).apiKey;
		}
		if (options.includeFallback === false) return undefined;
		return getEnvApiKey(providerId);
	}

	registerOAuthProvider(providerId: string, oauth: OAuthAuth): void {
		this.extensionOAuthProviders.set(providerId, oauth);
	}

	unregisterOAuthProvider(providerId: string): void {
		this.extensionOAuthProviders.delete(providerId);
	}

	getOAuthProviders(): Array<{ id: string; name: string }> {
		const dynamic = [...this.extensionOAuthProviders.entries()].map(([id, oauth]) => ({
			id,
			name: oauth.name,
		}));
		const builtin = builtinProviders().flatMap((provider) =>
			provider.auth.oauth && !this.extensionOAuthProviders.has(provider.id)
				? [{ id: provider.id, name: provider.auth.oauth.name }]
				: [],
		);
		return [...dynamic, ...builtin];
	}

	async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void> {
		const oauth =
			this.extensionOAuthProviders.get(providerId) ??
			builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
		if (!oauth) throw new Error(`Unknown OAuth provider: ${providerId}`);
		const signal = callbacks.signal ?? new AbortController().signal;
		const interaction: AuthInteraction & { signal: AbortSignal } = {
			signal,
			prompt: (prompt) => this.handleLegacyPrompt(prompt, callbacks),
			notify: (event) => this.handleLegacyEvent(event, callbacks),
		};
		const credential = await oauth.login(interaction);
		this.set(providerId, credential);
	}

	logout(provider: string): void {
		this.removeRuntimeApiKey(provider);
		this.remove(provider);
	}

	private handleLegacyPrompt(prompt: AuthPrompt, callbacks: OAuthLoginCallbacks): Promise<string> {
		switch (prompt.type) {
			case "manual_code":
				return callbacks.onManualCodeInput?.() ?? callbacks.onPrompt(prompt);
			case "select":
				return callbacks.onSelect(prompt).then((value) => {
					if (value === undefined) throw new Error("Login cancelled");
					return value;
				});
			case "secret":
			case "text":
				return callbacks.onPrompt(prompt);
		}
	}

	private handleLegacyEvent(event: AuthEvent, callbacks: OAuthLoginCallbacks): void {
		switch (event.type) {
			case "auth_url":
				callbacks.onAuth(event);
				break;
			case "device_code":
				callbacks.onDeviceCode(event);
				break;
			case "info":
				callbacks.onProgress?.(event.message);
				break;
			case "progress":
				callbacks.onProgress?.(event.message);
				break;
		}
	}
}

/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	try {
		const data = JSON.parse(stripBom(readFileSync(normalizePath(authPath), "utf-8"))) as AuthStorageData;
		// Read boundary (senpi#1989): try canonical, then the legacy spelling.
		return readByProviderId(data, providerId);
	} catch {
		return undefined;
	}
}
