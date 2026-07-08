import {
	discoverOAuthServerInfo,
	type OAuthServerInfo,
	refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { safeDelay } from "../wrap.ts";
import { isInvalidGrant, isTransientTokenError, OAuthFlowError } from "./oauth-errors.ts";
import {
	type McpOAuthProvider,
	mergeTokensIntoStoredAuth,
	REFRESH_LEEWAY_MS,
	storedAuthToTokens,
} from "./oauth-provider.ts";
import type { McpStoredAuth } from "./token-store.ts";

export interface RefreshManagerOptions {
	fetchFn?: FetchLike;
	maxRetries?: number;
	retryDelayMs?: number;
	discover?: (serverUrl: string) => Promise<OAuthServerInfo>;
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

	async ensureFresh(): Promise<OAuthTokens | undefined> {
		const record = this.#provider.store.read();
		if (record?.accessToken === undefined) return undefined;
		if (!isTokenStale(record, Date.now())) return storedAuthToTokens(record);
		return this.refresh();
	}

	refresh(): Promise<OAuthTokens> {
		if (this.#inflight !== undefined) return this.#inflight;
		const run = this.#refreshLocked().finally(() => {
			this.#inflight = undefined;
		});
		this.#inflight = run;
		return run;
	}

	#refreshLocked(): Promise<OAuthTokens> {
		return this.#provider.store.withLock(async () => {
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
			return this.#doRefresh(current, refreshToken);
		});
	}

	async #doRefresh(current: McpStoredAuth, refreshToken: string): Promise<OAuthTokens> {
		const info = await this.#discover();
		const clientInformation = this.#provider.clientInformation();
		if (clientInformation === undefined) {
			throw new OAuthFlowError("needs_auth", `MCP server ${this.#provider.serverName} is not registered`, {
				serverName: this.#provider.serverName,
			});
		}
		const resource = new URL(current.resource ?? this.#provider.serverUrl);
		const maxRetries = this.#options.maxRetries ?? 2;
		for (let attempt = 0; ; attempt++) {
			try {
				const tokens = await refreshAuthorization(info.authorizationServerUrl, {
					metadata: info.authorizationServerMetadata,
					clientInformation,
					refreshToken,
					resource,
					fetchFn: this.#options.fetchFn,
				});
				this.#provider.store.writeUnlocked(mergeTokensIntoStoredAuth(current, tokens, this.#provider.serverUrl));
				return tokens;
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

	#discover(): Promise<OAuthServerInfo> {
		if (this.#options.discover !== undefined) return this.#options.discover(this.#provider.serverUrl);
		return discoverOAuthServerInfo(this.#provider.serverUrl, { fetchFn: this.#options.fetchFn });
	}
}
