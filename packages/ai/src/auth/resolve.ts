import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { formatThrownValue } from "../utils/diagnostics.ts";
import { mergeRefreshed } from "./pool/slots.ts";
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

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/** Callers surface `error.message` only, so keep the underlying reason in it. */
function withCauseDetail(message: string, cause: unknown): string {
	if (cause === undefined || cause === null) return message;
	const detail = formatThrownValue(cause).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}

/**
 * Auth resolution shared by the `Models` and `ImagesModels` collections.
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
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * OAuth resolution with double-checked locking: tokens with less than five
 * minutes remaining lock, re-check expiry under the lock, refresh once
 * globally, and persist the rotated credential before release.
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
): Promise<AuthResult | undefined> {
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	let credential = stored;

	if (expiresSoon(credential)) {
		// Optimistic check said expired; the authoritative check runs under the lock.
		let post: Credential | undefined;
		try {
			post = await credentials.modify(
				providerId,
				async (current) => {
					if (current?.type !== "oauth") return undefined; // logged out meanwhile
					if (!expiresSoon(current)) return undefined; // another process/request refreshed
					try {
						const refreshSignal = AbortSignal.any([
							signal,
							AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS),
						]);
						const refreshed = await oauth.refresh(current, refreshSignal);
						return mergeRefreshed(current, refreshed);
					} catch (error) {
						throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
					}
				},
				{ signal },
			);
		} catch (error) {
			if (error instanceof ModelsError) throw error;
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		if (post?.type !== "oauth") return undefined; // logged out meanwhile
		credential = post;
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
