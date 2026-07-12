import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * Standard api-key auth: a stored credential key wins, otherwise the first
 * set env var resolves, followed by an optional local-server fallback key.
 * Includes a `login` that prompts for the key. Providers with non-standard
 * resolution (provider env, ambient files, IAM) write their own `ApiKeyAuth`.
 */
export function envApiKeyAuth(
	name: string,
	envVars: readonly string[],
	options?: { fallbackApiKey?: string },
): ApiKeyAuth {
	return {
		name,
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: `Enter ${name}` });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			if (options?.fallbackApiKey) {
				return { auth: { apiKey: options.fallbackApiKey }, source: "built-in fallback" };
			}
			return undefined;
		},
	};
}

/**
 * Wraps a dynamically imported `OAuthAuth` so provider definitions can
 * advertise OAuth without importing the implementation. The flow loads on
 * first `login`/`refresh`/`toAuth` call; callers keep Node-only flow code out
 * of bundles by loading through a bundler-opaque dynamic import (variable
 * specifier, see the bedrock lazy wrapper).
 */
export function lazyOAuth(input: { name: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		login: async (callbacks) => (await loaded()).login(callbacks),
		refresh: async (credential) => (await loaded()).refresh(credential),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
