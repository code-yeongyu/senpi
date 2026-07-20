/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */

import type {
	ApiKeyCredential,
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthCredential,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

type AuthStorageData = Record<string, Credential>;

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

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
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
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
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
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
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
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
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

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage implements CredentialStore {
	private data: AuthStorageData = {};
	private readonly runtimeOverrides = new Map<string, string>();
	private errors: Error[] = [];
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
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
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	private recordError(error: unknown): void {
		this.errors.push(error instanceof Error ? error : new Error(String(error)));
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
		} catch (error) {
			// Preserve the last valid in-memory snapshot.
			this.recordError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/** Set a non-persistent API key used ahead of stored credentials. */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	get(provider: string): Credential | undefined {
		return this.data[provider];
	}

	getProviderEnv(provider: string): Record<string, string> | undefined {
		const credential = this.data[provider];
		return credential?.type === "api_key" && credential.env ? { ...credential.env } : undefined;
	}

	set(provider: string, credential: Credential): void {
		this.storage.withLock((content) => {
			const nextData = { ...this.parseStorageData(content), [provider]: credential };
			this.data = nextData;
			return { result: undefined, next: JSON.stringify(nextData, null, 2) };
		});
	}

	remove(provider: string): void {
		this.storage.withLock((content) => {
			const nextData = { ...this.parseStorageData(content) };
			delete nextData[provider];
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

	async read(provider: string): Promise<Credential | undefined> {
		const runtimeKey = this.runtimeOverrides.get(provider);
		if (runtimeKey) return { type: "api_key", key: runtimeKey };
		const credential = this.data[provider];
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const next = await fn(currentData[provider]);
			if (next === undefined) {
				this.data = currentData;
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			this.data = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		});
	}

	async delete(provider: string): Promise<void> {
		this.runtimeOverrides.delete(provider);
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			this.data = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		});
	}

	/** List credential metadata without resolving configured key values. */
	async list(): Promise<readonly CredentialInfo[]> {
		const entries = new Map(
			Object.entries(this.data).map(([providerId, credential]) => [
				providerId,
				{ providerId, type: credential.type },
			]),
		);
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
					return Date.now() < stored.expires ? stored : oauth.refresh(stored);
				});
				if (refreshed?.type !== "oauth") return undefined;
				current = refreshed;
			}
			return (await oauth.toAuth(current)).apiKey;
		}
		if (options.includeFallback === false) return undefined;
		return getEnvApiKey(providerId);
	}

	getOAuthProviders(): Array<{ id: string; name: string }> {
		return builtinProviders().flatMap((provider) =>
			provider.auth.oauth ? [{ id: provider.id, name: provider.auth.oauth.name }] : [],
		);
	}

	async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void> {
		const oauth = builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
		if (!oauth) throw new Error(`Unknown OAuth provider: ${providerId}`);
		const interaction: AuthInteraction = {
			signal: callbacks.signal,
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
		const data = JSON.parse(readFileSync(normalizePath(authPath), "utf-8")) as AuthStorageData;
		return data[providerId];
	} catch {
		return undefined;
	}
}
