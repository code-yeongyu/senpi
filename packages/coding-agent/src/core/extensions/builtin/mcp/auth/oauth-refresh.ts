import type { OAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadMcpSdkAuth } from "../sdk.lazy.ts";
import { safeDelay } from "../wrap.ts";
import { isInvalidGrant, isTransientTokenError, OAuthFlowError } from "./oauth-errors.ts";
import { oauthFetch } from "./oauth-fetch.ts";
import { credentialsMatchIssuer, validatedAuthorizationServerIssuer } from "./oauth-issuer.ts";
import {
	type McpOAuthProvider,
	mergeTokensIntoStoredAuth,
	REFRESH_LEEWAY_MS,
	storedAuthToTokens,
	storedGrantIssuer,
} from "./oauth-provider.ts";
import type { McpStoredAuth } from "./token-store.ts";

export interface RefreshManagerOptions {
	fetchFn?: FetchLike;
	maxRetries?: number;
	retryDelayMs?: number;
	discover?: (serverUrl: string, signal?: AbortSignal) => Promise<OAuthServerInfo>;
}

export function isTokenStale(record: McpStoredAuth | undefined, now: number): boolean {
	const token = record?.accessToken;
	if (token === undefined || token.length === 0) return true;
	if (record?.expiresAt === undefined) return false;
	return record.expiresAt - now <= REFRESH_LEEWAY_MS;
}

export function assertS256Supported(metadata: AuthorizationServerMetadata | undefined, serverName: string): void {
	const methods = metadata?.code_challenge_methods_supported;
	if (methods === undefined || !methods.includes("S256")) {
		throw new OAuthFlowError(
			"s256_unsupported",
			`MCP server ${serverName} authorization server does not advertise PKCE S256 (code_challenge_methods_supported); refusing to authorize without proof-key protection.`,
			{ serverName },
		);
	}
}

// Coalesces refresh across in-process callers (single promise) and across
// processes (token-store lock). Preemptive at expiry - 5min.
export class McpRefreshManager {
	readonly #provider: McpOAuthProvider;
	readonly #options: RefreshManagerOptions;
	#inflight: Promise<OAuthTokens> | undefined;

	constructor(provider: McpOAuthProvider, options: RefreshManagerOptions = {}) {
		this.#provider = provider;
		this.#options = options;
	}

	/**
	 * `signal` (senpi#4642): an aborted caller stops waiting at once. A refresh it started stops only at a step
	 * before its token request is sent (the lock wait, discovery, a retry backoff): it then releases the lock and
	 * writes nothing. Once the token request is sent the refresh is not aborted: it finishes detached and persists
	 * the rotated tokens, because the server may already have invalidated the old refresh token.
	 */
	async ensureFresh(signal?: AbortSignal): Promise<OAuthTokens | undefined> {
		signal?.throwIfAborted();
		const record = await this.#provider.store.readAsync();
		if (record?.accessToken === undefined) return undefined;
		if (!isTokenStale(record, Date.now())) return storedAuthToTokens(record);
		return this.refresh(signal);
	}

	refresh(signal?: AbortSignal): Promise<OAuthTokens> {
		if (this.#inflight !== undefined) return untilAborted(this.#inflight, signal);
		const run = this.#refreshLocked(signal).finally(() => {
			this.#inflight = undefined;
		});
		this.#inflight = run;
		return untilAborted(run, signal);
	}

	#refreshLocked(signal: AbortSignal | undefined): Promise<OAuthTokens> {
		return this.#provider.store.withLock(async () => {
			signal?.throwIfAborted();
			const current = this.#provider.store.readUnlocked();
			if (current?.accessToken !== undefined && !isTokenStale(current, Date.now())) {
				const tokens = storedAuthToTokens(current);
				if (tokens !== undefined) return tokens;
			}
			const refreshToken = current?.refreshToken;
			if (current === undefined || refreshToken === undefined) {
				throw new OAuthFlowError("needs_auth", `MCP server ${this.#provider.serverName} has no refresh token`, {
					serverName: this.#provider.serverName,
				});
			}
			return this.#doRefresh(current, refreshToken, signal);
		});
	}

	async #doRefresh(
		current: McpStoredAuth,
		refreshToken: string,
		signal: AbortSignal | undefined,
	): Promise<OAuthTokens> {
		const info = await this.#discover(signal);
		signal?.throwIfAborted();
		// senpi#2940: a refresh token is presented only to the authorization server that issued it. A grant bound
		// elsewhere, or one that cannot be attributed at all, is a continuity break: drop it and require a fresh
		// sign-in rather than refreshing silently against whatever server discovery now names.
		const issuer = storedGrantIssuer(current);
		const authorizationServer = validatedAuthorizationServerIssuer(info, this.#provider.serverName);
		if (issuer === undefined || !credentialsMatchIssuer(current, authorizationServer)) {
			this.#provider.store.writeUnlocked(undefined);
			throw new OAuthFlowError(
				"needs_auth",
				issuer === undefined
					? `MCP server ${this.#provider.serverName} has a saved sign-in with no record of the authorization server that issued it; credentials cleared, re-authentication required.`
					: `MCP server ${this.#provider.serverName} now uses authorization server ${authorizationServer}, but its saved sign-in was issued by ${issuer}; credentials cleared, re-authentication required.`,
				{ serverName: this.#provider.serverName },
			);
		}
		const clientInformation = this.#provider.clientInformation();
		if (clientInformation === undefined) {
			throw new OAuthFlowError("needs_auth", `MCP server ${this.#provider.serverName} is not registered`, {
				serverName: this.#provider.serverName,
			});
		}
		const resource = new URL(current.resource ?? this.#provider.serverUrl);
		const { refreshAuthorization } = await loadMcpSdkAuth();
		const maxRetries = this.#options.maxRetries ?? 2;
		for (let attempt = 0; ; attempt++) {
			// The last point an abort may stop the refresh: nothing has been sent to the token endpoint yet.
			signal?.throwIfAborted();
			try {
				// Sent without the signal: a rotated refresh token the server issues must reach the store.
				const tokens = await refreshAuthorization(info.authorizationServerUrl, {
					metadata: info.authorizationServerMetadata,
					clientInformation,
					refreshToken,
					resource,
					fetchFn: oauthFetch(this.#options.fetchFn),
				});
				this.#provider.store.writeUnlocked(
					mergeTokensIntoStoredAuth(current, tokens, this.#provider.serverUrl, authorizationServer),
				);
				return { ...tokens, issuer: authorizationServer };
			} catch (error) {
				if (isInvalidGrant(error)) {
					// Terminal: drop credentials so the next use forces a clean re-auth.
					this.#provider.store.writeUnlocked(undefined);
					throw new OAuthFlowError(
						"invalid_grant",
						`MCP server ${this.#provider.serverName} refresh rejected (invalid_grant); credentials cleared, re-authentication required.`,
						{
							cause: error,
							serverName: this.#provider.serverName,
						},
					);
				}
				if (isTransientTokenError(error) && attempt < maxRetries) {
					await safeDelay(this.#options.retryDelayMs ?? 50);
					continue;
				}
				// Transient but exhausted: surface without clearing credentials (needs_auth NOT set).
				throw new OAuthFlowError(
					"transient",
					`MCP server ${this.#provider.serverName} token refresh failed transiently; will retry on next use.`,
					{
						cause: error,
						retriable: true,
						serverName: this.#provider.serverName,
					},
				);
			}
		}
	}

	async #discover(signal: AbortSignal | undefined): Promise<OAuthServerInfo> {
		if (this.#options.discover !== undefined) return this.#options.discover(this.#provider.serverUrl, signal);
		const { discoverOAuthServerInfo } = await loadMcpSdkAuth();
		return discoverOAuthServerInfo(this.#provider.serverUrl, { fetchFn: oauthFetch(this.#options.fetchFn, signal) });
	}
}

/** The caller stops waiting when its own signal aborts; the shared work itself is left to its starter. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
