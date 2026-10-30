import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpLogger } from "../log.ts";
import { fingerprintSecret } from "../log.ts";
import { OAuthFlowError } from "./oauth-errors.ts";
import {
	canonicalAuthorizationServerIssuer,
	credentialsMatchIssuer,
	validatedAuthorizationServerIssuer,
} from "./oauth-issuer.ts";
import type { McpStoredAuth, McpTokenStore } from "./token-store.ts";

// Buffer before absolute token expiry at which a refresh is considered due.
export const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export interface McpOAuthProviderOptions {
	serverName: string;
	serverUrl: string;
	store: McpTokenStore;
	redirectUrl?: string | URL;
	scopes?: string[];
	clientId?: string;
	clientMetadataUrl?: string;
	logger?: McpLogger;
	onRedirect?: (url: URL) => void | Promise<void>;
}

export function tokenExpiresAt(tokens: OAuthTokens, now = Date.now()): number | undefined {
	if (tokens.expires_in === undefined) return undefined;
	return now + tokens.expires_in * 1000;
}

/**
 * The authorization server a stored grant belongs to (senpi#2940, GHSA-6qxp-vccf-f47h): its `issuer` stamp, or
 * for a record saved before the stamp existed, the authorization server its sign-in discovered. A record with
 * neither cannot be attributed, so its refresh token is never presented anywhere.
 */
export function storedGrantIssuer(record: McpStoredAuth | undefined): string | undefined {
	return record?.issuer ?? record?.discoveryState?.authorizationServerUrl?.toString();
}

/**
 * Fixes who an unstamped grant belongs to before the discovery record it falls back to is replaced (senpi#2940).
 * A later discovery reflects what the MCP server advertises now, not where the grant was issued, so it must never
 * attribute an existing grant: the grant keeps the server it was attributed to, or loses its refresh token.
 */
export function freezeGrantAttribution(record: McpStoredAuth | undefined): McpStoredAuth {
	const next: McpStoredAuth = { ...(record ?? {}) };
	if (next.issuer !== undefined || (next.accessToken === undefined && next.refreshToken === undefined)) return next;
	const issuer = storedGrantIssuer(next);
	if (issuer !== undefined) next.issuer = issuer;
	else delete next.refreshToken;
	return next;
}

/**
 * Whether a stored discovery record carries its own evidence for the authorization server it names (senpi#4924):
 * that server's metadata, the MCP server's protected-resource metadata naming it, or the MCP server's own origin
 * (the SDK's legacy root fallback). A bare URL from anywhere else would send the SDK to an unverified server.
 */
export function discoveryNamesItsServer(state: OAuthDiscoveryState, serverUrl: string): boolean {
	if (state.authorizationServerMetadata !== undefined) return true;
	const named = canonicalAuthorizationServerIssuer(String(state.authorizationServerUrl));
	if (named === new URL(serverUrl).origin) return true;
	return (
		state.resourceMetadata?.authorization_servers?.some(
			(server) => canonicalAuthorizationServerIssuer(String(server)) === named,
		) ?? false
	);
}

export function storedAuthToTokens(record: McpStoredAuth | undefined, now = Date.now()): OAuthTokens | undefined {
	if (record?.accessToken === undefined || record.accessToken.length === 0) return undefined;
	const expiresIn =
		record.expiresAt === undefined ? undefined : Math.max(0, Math.ceil((record.expiresAt - now) / 1000));
	const issuer = storedGrantIssuer(record);
	return {
		access_token: record.accessToken,
		// An unattributed refresh token is withheld: the SDK would post it to whichever server it discovers.
		refresh_token: issuer === undefined ? undefined : record.refreshToken,
		token_type: "Bearer",
		...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
		...(issuer === undefined ? {} : { issuer }),
	};
}

export function mergeTokensIntoStoredAuth(
	current: McpStoredAuth | undefined,
	tokens: OAuthTokens,
	serverUrl: string,
	issuer?: string,
): McpStoredAuth {
	const next: McpStoredAuth = {
		...(current ?? {}),
		accessToken: tokens.access_token,
		resource: current?.resource ?? serverUrl,
	};
	const refreshToken = tokens.refresh_token ?? current?.refreshToken;
	if (refreshToken !== undefined) next.refreshToken = refreshToken;
	const expiresAt = tokenExpiresAt(tokens);
	if (expiresAt !== undefined) next.expiresAt = expiresAt;
	else delete next.expiresAt;
	const stamp = tokens.issuer ?? issuer;
	if (stamp !== undefined) next.issuer = stamp;
	return next;
}

// Implements the SDK OAuthClientProvider backed by the URL-bound token store.
// All persistence goes through the store so tokens survive process restarts and
// stay lockable across processes.
export class McpOAuthProvider implements OAuthClientProvider {
	readonly #options: McpOAuthProviderOptions;
	#expectedState: string | undefined;
	#lastAuthorizationUrl: URL | undefined;

	constructor(options: McpOAuthProviderOptions) {
		this.#options = options;
	}

	get lastAuthorizationUrl(): URL | undefined {
		return this.#lastAuthorizationUrl;
	}

	get redirectUrl(): string | URL | undefined {
		return this.#options.redirectUrl;
	}

	get clientMetadataUrl(): string | undefined {
		return this.#options.clientMetadataUrl;
	}

	get clientMetadata(): OAuthClientMetadata & { application_type?: "native" | "web" } {
		const redirect = this.#options.redirectUrl;
		return {
			...(redirect === undefined
				? {}
				: {
						application_type:
							!["http:", "https:"].includes(new URL(redirect).protocol) ||
							["127.0.0.1", "localhost", "[::1]"].includes(new URL(redirect).hostname)
								? "native"
								: "web",
					}),
			redirect_uris: redirect === undefined ? [] : [String(redirect)],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			client_name: "senpi",
			scope: this.#options.scopes?.join(" "),
		};
	}

	state(): string {
		this.#expectedState = randomBytes(16).toString("base64url");
		return this.#expectedState;
	}

	// Single-use CSRF check: a state is valid at most once.
	consumeState(candidate: string | undefined): boolean {
		const expected = this.#expectedState;
		this.#expectedState = undefined;
		return expected !== undefined && candidate === expected;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		if (this.#options.clientId !== undefined) return { client_id: this.#options.clientId };
		if (this.#options.clientMetadataUrl !== undefined) return { client_id: this.#options.clientMetadataUrl };
		return this.#store.read()?.clientInfo;
	}

	async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
		const discovery = this.discoveryState();
		const issuer =
			discovery === undefined
				? info.issuer && canonicalAuthorizationServerIssuer(info.issuer)
				: validatedAuthorizationServerIssuer(discovery, this.serverName);
		await this.#store.update((current) => ({ ...(current ?? {}), clientInfo: { ...info, issuer } }));
	}

	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		const issuer = validatedAuthorizationServerIssuer(state, this.serverName);
		const discoveryState = { ...state, authorizationServerUrl: issuer };
		await this.#store.update((current) => {
			const attributed = freezeGrantAttribution(current);
			if (!credentialsMatchIssuer(attributed, issuer)) return { discoveryState };
			const clientIssuer = attributed.clientInfo?.issuer ?? storedGrantIssuer(attributed);
			return {
				...attributed,
				// Unattributed legacy registrations cannot be sent to the server discovered now.
				clientInfo:
					clientIssuer === undefined || attributed.clientInfo === undefined
						? undefined
						: { ...attributed.clientInfo, issuer },
				discoveryState,
			};
		});
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		const current = this.#store.read();
		const state = current?.discoveryState;
		// senpi#4924: a record that does not show where its authorization server came from is never handed out.
		// The SDK would fetch metadata from the stored URL and post the saved grant there before anything checks
		// that the MCP server names that server; callers discover from the MCP server instead.
		if (state !== undefined && !discoveryNamesItsServer(state, this.serverUrl)) return undefined;
		if (state !== undefined) {
			try {
				const issuer = validatedAuthorizationServerIssuer(state, this.serverName);
				if (!credentialsMatchIssuer(current, issuer)) return undefined;
			} catch (error) {
				if (error instanceof OAuthFlowError) return undefined;
				throw error;
			}
		}
		return state;
	}

	tokens(): OAuthTokens | undefined {
		return storedAuthToTokens(this.#store.read());
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const discovery = this.discoveryState();
		const issuer =
			discovery === undefined
				? tokens.issuer && canonicalAuthorizationServerIssuer(tokens.issuer)
				: validatedAuthorizationServerIssuer(discovery, this.serverName);
		await this.#store.update((current) => mergeTokensIntoStoredAuth(current, { ...tokens, issuer }, this.serverUrl));
		this.#logFingerprint("saveTokens", tokens.access_token);
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.#store.update((current) => ({ ...(current ?? {}), codeVerifier }));
	}

	codeVerifier(): string {
		const verifier = this.#store.read()?.codeVerifier;
		if (verifier === undefined || verifier.length === 0) {
			throw new OAuthFlowError("no_verifier", `Missing PKCE code verifier for MCP server ${this.serverName}`, {
				serverName: this.serverName,
			});
		}
		return verifier;
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		this.#lastAuthorizationUrl = authorizationUrl;
		await this.#options.onRedirect?.(authorizationUrl);
	}

	// RFC 8707: bind the token to this MCP resource.
	validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
		return Promise.resolve(new URL(resource ?? String(serverUrl)));
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "all") {
			await this.#store.clear();
			return;
		}
		await this.#store.update((current) => {
			if (current === undefined) return current;
			const next: McpStoredAuth = { ...current };
			if (scope === "tokens") {
				delete next.accessToken;
				delete next.refreshToken;
				delete next.expiresAt;
			}
			if (scope === "verifier") next.codeVerifier = undefined;
			if (scope === "client") next.clientInfo = undefined;
			if (scope === "discovery") next.discoveryState = undefined;
			return next;
		});
	}

	get serverName(): string {
		return this.#options.serverName;
	}
	get serverUrl(): string {
		return this.#options.serverUrl;
	}
	get store(): McpTokenStore {
		return this.#options.store;
	}
	get scopes(): string[] | undefined {
		return this.#options.scopes;
	}

	get #store(): McpTokenStore {
		return this.#options.store;
	}

	#logFingerprint(event: string, secret: string): void {
		this.#options.logger?.info(`oauth ${event}`, { token_fp: fingerprintSecret(secret) });
	}
}
