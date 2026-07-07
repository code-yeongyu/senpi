import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpLogger } from "../log.ts";
import { fingerprintSecret } from "../log.ts";
import { OAuthFlowError } from "./oauth-errors.ts";
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

export function storedAuthToTokens(record: McpStoredAuth | undefined, now = Date.now()): OAuthTokens | undefined {
	if (record?.accessToken === undefined || record.accessToken.length === 0) return undefined;
	const expiresIn =
		record.expiresAt === undefined ? undefined : Math.max(0, Math.ceil((record.expiresAt - now) / 1000));
	return {
		access_token: record.accessToken,
		refresh_token: record.refreshToken,
		token_type: "Bearer",
		...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
	};
}

export function mergeTokensIntoStoredAuth(
	current: McpStoredAuth | undefined,
	tokens: OAuthTokens,
	serverUrl: string,
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

	get clientMetadata(): OAuthClientMetadata {
		const redirect = this.#options.redirectUrl;
		return {
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
		await this.#store.update((current) => ({ ...(current ?? {}), clientInfo: info }));
	}

	tokens(): OAuthTokens | undefined {
		return storedAuthToTokens(this.#store.read());
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.#store.update((current) => mergeTokensIntoStoredAuth(current, tokens, this.serverUrl));
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
