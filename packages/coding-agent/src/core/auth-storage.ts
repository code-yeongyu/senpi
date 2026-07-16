/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@earendil-works/pi-ai/compat";
import {
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviders,
	type OAuthProviderInterface,
	resolveOAuthStorageProvider,
} from "@earendil-works/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import type { CredentialSelector, CredentialVault, SelectionLease, UsageReport } from "./auth-multi-account.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	env?: Record<string, string>;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export interface GetApiKeyOptions {
	includeFallback?: boolean;
}

export type PooledCredentialOptions = {
	selector?: CredentialSelector;
	sessionId?: string;
};

export type PooledCredentialSelection = {
	apiKey: string;
	credentialId: string;
	reportOutcome: (status: UsageReport["status"]) => void;
};

export type ResolvedCredentialAuth = {
	readonly apiKey: string;
	readonly headers?: Readonly<Record<string, string>>;
};

type RequestAuthOAuthProvider = OAuthProviderInterface & {
	getRequestAuth(credentials: OAuthCredentials): Promise<ResolvedCredentialAuth>;
};

function supportsRequestAuth(provider: OAuthProviderInterface): provider is RequestAuthOAuthProvider {
	return "getRequestAuth" in provider && typeof provider.getRequestAuth === "function";
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
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;
	private credentialVault: CredentialVault | undefined;

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

	setCredentialVault(vault: CredentialVault | undefined): void {
		this.credentialVault = vault;
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(resolveOAuthStorageProvider(provider), apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(resolveOAuthStorageProvider(provider));
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
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
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): AuthStorageData {
		if (this.loadError) {
			this.reload();
		}

		if (this.loadError) {
			const error = new Error(
				`Cannot update auth storage because it could not be loaded: ${this.loadError.message}`,
			);
			this.recordError(error);
			throw error;
		}

		try {
			let persistedData: AuthStorageData = {};
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				persistedData = merged;
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
			this.loadError = null;
			return persistedData;
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[resolveOAuthStorageProvider(provider)] ?? undefined;
	}

	/**
	 * Get provider-scoped environment values for an API key credential.
	 */
	getProviderEnv(provider: string): Record<string, string> | undefined {
		const cred = this.data[resolveOAuthStorageProvider(provider)];
		return cred?.type === "api_key" && cred.env ? { ...cred.env } : undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.data = this.persistProviderChange(resolveOAuthStorageProvider(provider), credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		this.data = this.persistProviderChange(resolveOAuthStorageProvider(provider), undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return resolveOAuthStorageProvider(provider) in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.runtimeOverrides.has(storageProvider)) return true;
		if (this.data[storageProvider]) return true;
		if (getEnvApiKey(provider)) return true;
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.data[storageProvider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(storageProvider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const storageProvider = resolveOAuthStorageProvider(providerId);
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const cred = currentData[storageProvider];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}
			oauthCreds[providerId] = cred;

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[storageProvider]: { type: "oauth", ...refreshed.newCredentials },
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		return result;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 */
	async getApiKey(providerId: string, options: GetApiKeyOptions = {}): Promise<string | undefined> {
		return (await this.getRequestAuth(providerId, options))?.apiKey;
	}

	async getRequestAuth(
		providerId: string,
		options: GetApiKeyOptions = {},
	): Promise<ResolvedCredentialAuth | undefined> {
		const storageProvider = resolveOAuthStorageProvider(providerId);
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(storageProvider);
		if (runtimeKey) {
			return { apiKey: runtimeKey };
		}

		const cred = this.data[storageProvider];

		if (cred?.type === "api_key") {
			const apiKey = resolveConfigValue(cred.key, cred.env);
			return apiKey === undefined ? undefined : { apiKey };
		}

		if (cred?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				// Unknown OAuth provider, can't get API key
				return undefined;
			}

			// Check if token needs refresh
			const needsRefresh = Date.now() >= cred.expires;

			if (needsRefresh) {
				// Use locked refresh to prevent race conditions
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return this.resolveOAuthRequestAuth(provider, result.newCredentials);
					}
				} catch (error) {
					this.recordError(error);
					// Refresh failed - re-read file to check if another instance succeeded
					this.reload();
					const updatedCred = this.data[storageProvider];

					if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
						// Another instance refreshed successfully, use those credentials
						return this.resolveOAuthRequestAuth(provider, updatedCred);
					}

					// Refresh truly failed - return undefined so model discovery skips this provider
					// User can /login to re-authenticate (credentials preserved for retry)
					return undefined;
				}
			} else {
				// Token not expired, use current access token
				return this.resolveOAuthRequestAuth(provider, cred);
			}
		}

		if (options.includeFallback === false) return undefined;

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return { apiKey: envKey };

		return undefined;
	}

	private async resolveOAuthRequestAuth(
		provider: OAuthProviderInterface,
		credentials: OAuthCredentials,
	): Promise<ResolvedCredentialAuth> {
		return supportsRequestAuth(provider)
			? provider.getRequestAuth(credentials)
			: { apiKey: provider.getApiKey(credentials) };
	}

	selectPooledCredential(
		providerId: string,
		options: PooledCredentialOptions = {},
	): PooledCredentialSelection | undefined {
		const storageProvider = resolveOAuthStorageProvider(providerId);
		if (
			this.runtimeOverrides.has(storageProvider) ||
			this.data[storageProvider] !== undefined ||
			this.credentialVault === undefined
		) {
			return undefined;
		}

		const pool = this.credentialVault
			.metadataSnapshot()
			.credentials.find((credential) => credential.pool.provider === storageProvider)?.pool;
		if (pool === undefined) return undefined;
		const pending = this.credentialVault.issueSelectionLease(
			{ pool, selector: options.selector ?? { kind: "automatic" }, sessionId: options.sessionId },
			"local-auth-storage",
		);
		const lease = this.credentialVault.consumeSelectionLease({
			authentication: "local-auth-storage",
			leaseId: pending.leaseId,
		});
		return selectionFromLease(lease);
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}

function selectionFromLease(lease: SelectionLease): PooledCredentialSelection {
	const apiKey = lease.material.type === "api_key" ? lease.material.apiKey : lease.material.accessToken;
	return {
		apiKey,
		credentialId: lease.credentialId,
		reportOutcome: (status) => {
			lease.reportOutcome({ observedAt: new Date().toISOString(), status });
		},
	};
}
