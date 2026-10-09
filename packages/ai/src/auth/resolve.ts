import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { ModelsError } from "../utils/models-error.ts";
import { classifyOAuthRefreshFailure, OAuthRefreshUnavailableError } from "../utils/oauth-refresh-error.ts";
import {
	OAuthRefreshExchangeError,
	OAuthRefreshStoreError,
	projectOAuthSlot,
	refreshOAuthCredential,
} from "./oauth-refresh.ts";
import { projectSlot } from "./pool/slots.ts";

export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";

import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
	/**
	 * Resolve against one named slot of a pooled credential. A missing entry or
	 * slot resolves to undefined rather than falling back to another account or
	 * ambient env, so a slot-scoped request can never silently switch identities.
	 */
	slotName?: string;
	/**
	 * An access token the provider just refused with one of its
	 * `OAuthAuth.rejectedTokenStatuses`. A stored OAuth credential still carrying it
	 * is re-exchanged regardless of its expiry; one already rotated is used as is.
	 */
	rejectedAccess?: string;
	signal?: AbortSignal;
}

/**
 * Prefix of the auth-miss every resolution site raises when a provider has no
 * usable credential. Consumers key recovery decisions off this exact wording,
 * so it is a shared constant instead of a literal repeated at each throw site:
 * rewording one copy would silently disable the other's behavior.
 */
export const PROVIDER_NOT_CONFIGURED_PREFIX = "Provider is not configured: ";

export function providerNotConfiguredMessage(providerId: string): string {
	return `${PROVIDER_NOT_CONFIGURED_PREFIX}${providerId}`;
}

/**
 * Auth resolution shared by all operations in a `Models` collection.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	return raceWithAbortSignal(
		resolveProviderAuthWithSignal(provider, credentials, authContext, overrides, signal),
		signal,
	);
}

async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;
	const apiKey = provider.auth.apiKey;

	if (overrides?.apiKey !== undefined && apiKey && !apiKey.ambientOnly) {
		return resolveApiKey(
			requestAuthContext,
			apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	const stored = await readCredential(credentials, provider.id, signal);
	const slotName = overrides?.slotName;
	if (slotName !== undefined) {
		const projected = stored === undefined ? undefined : projectSlot(stored, slotName);
		if (!projected) return undefined;
		if (projected.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				projected,
				requestAuthContext,
				overrides?.env,
				signal,
				overrides?.minOAuthValidityMs,
				slotName,
				overrides?.rejectedAccess,
			);
		}
		if (projected.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...projected, env: { ...projected.env, ...overrides.env } } : projected;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		return undefined;
	}
	if (stored) {
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				stored,
				requestAuthContext,
				overrides?.env,
				signal,
				overrides?.minOAuthValidityMs,
				undefined,
				overrides?.rejectedAccess,
			);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		return undefined;
	}

	if (overrides?.apiKey !== undefined && apiKey) {
		return resolveApiKey(
			requestAuthContext,
			apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	// Ambient (env vars, AWS profiles, ADC files).
	const ambientCredential =
		apiKey?.ambientOnly && overrides?.env ? { type: "api_key" as const, key: "", env: overrides.env } : undefined;
	return apiKey ? resolveApiKey(requestAuthContext, apiKey, provider.id, ambientCredential, signal) : undefined;
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => (env[name] !== undefined ? env[name] : await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;

/** Maps a shared-refresh failure onto the `ModelsError` codes callers match on. */
export function oauthRefreshModelsError(error: unknown, providerId: string): ModelsError {
	if (error instanceof ModelsError) return error;
	if (error instanceof OAuthRefreshExchangeError) {
		if (classifyOAuthRefreshFailure(error.cause) === "transient") {
			return new OAuthRefreshUnavailableError(providerId, error.cause);
		}
		return new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error.cause });
	}
	const cause = error instanceof OAuthRefreshStoreError ? error.cause : error;
	return new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause });
}

/**
 * OAuth resolution: a token with less than five minutes remaining is refreshed
 * through `refreshOAuthCredential`, which re-checks the stored value, runs the
 * exchange outside the store lock, and compare-and-swaps the rotated slot.
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	authContext: AuthContext,
	requestEnv: ProviderEnv | undefined,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
	slotName?: string,
	rejectedAccess?: string,
): Promise<AuthResult | undefined> {
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	const isStale = (credential: OAuthCredential) =>
		expiresSoon(credential) || (rejectedAccess !== undefined && credential.access === rejectedAccess);
	let credential = stored;

	if (isStale(credential)) {
		let post: Credential | undefined;
		try {
			post = await refreshOAuthCredential({
				credentials,
				providerId,
				oauth,
				stale: credential,
				slotName,
				isStale,
				signal,
				owning: true,
			});
		} catch (error) {
			signal.throwIfAborted();
			throw oauthRefreshModelsError(error, providerId);
		}
		if (post?.type !== "oauth") return undefined; // logged out meanwhile
		const postView = slotName === undefined ? post : projectOAuthSlot(post, slotName);
		if (!postView) return undefined; // slot removed meanwhile
		credential = postView;
		// The normal five-minute window triggers a refresh but does not impose a
		// provider contract. Explicit callers (such as bearer-token export) do
		// require the requested minimum after the refresh.
		if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	const storedEnv = credentialEnvironment(credential);
	const effectiveEnv = requestEnv ? { ...storedEnv, ...requestEnv } : storedEnv;
	const effectiveCredential = effectiveEnv ? { ...credential, env: effectiveEnv } : credential;

	if (oauth.check) {
		try {
			if (!(await oauth.check({ ctx: authContext, credential: effectiveCredential, signal }))) return undefined;
		} catch (error) {
			throw new ModelsError("auth", `OAuth auth check failed for provider ${providerId}`, { cause: error });
		}
	}

	try {
		return {
			auth: await oauth.toAuth(effectiveCredential),
			...(effectiveEnv ? { env: effectiveEnv } : {}),
			source: "OAuth",
		};
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

function credentialEnvironment(credential: OAuthCredential): ProviderEnv | undefined {
	const value = credential.env;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const environment: ProviderEnv = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry !== "string") return undefined;
		environment[name] = entry;
	}
	return environment;
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential, signal });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
