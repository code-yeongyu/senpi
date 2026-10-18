/**
 * Effective credential for a provider's catalog refresh (`Models.refresh`).
 * OAuth credentials are refreshed before network access; the exchange is
 * joined without owning it, so superseding the catalog refresh stops waiting
 * but never aborts a token exchange another lane may be relying on (#1542).
 */

import { refreshOAuthCredential } from "./oauth-refresh.ts";
import { oauthRefreshModelsError } from "./resolve.ts";
import type { AuthContext, Credential, CredentialStore, ProviderAuth } from "./types.ts";

export async function resolveRefreshCredential(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	stored: Credential | undefined,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	if (stored?.type === "oauth") {
		const oauth = provider.auth.oauth;
		if (!oauth) return undefined;
		if (Date.now() < stored.expires) return stored;
		if (signal.aborted) return undefined;
		let post: Credential | undefined;
		try {
			post = await refreshOAuthCredential({
				credentials,
				providerId: provider.id,
				oauth,
				stale: stored,
				isStale: (credential) => Date.now() >= credential.expires,
				signal,
				owning: false,
			});
		} catch (error) {
			throw oauthRefreshModelsError(error, provider.id);
		}
		return post?.type === "oauth" ? post : undefined;
	}

	const apiKey = provider.auth.apiKey;
	if (!apiKey) return undefined;
	const credential = stored?.type === "api_key" ? stored : undefined;
	const result = await apiKey.resolve({ ctx: authContext, credential, signal });
	if (!result) return undefined;
	return { type: "api_key", key: result.auth.apiKey, env: result.env };
}
