import { randomBytes } from "node:crypto";
import { oauthBrandName } from "@earendil-works/pi-ai/utils/oauth-page";
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
	freezeGrantAttribution,
	grantBinding,
	type McpGrantContext,
	mergeOAuthTokenResponse,
	storedAuthToTokens,
	storedGrantIssuer,
} from "./oauth-grant.ts";
import {
	canonicalAuthorizationServerIssuer,
	credentialsMatchIssuer,
	discoveryNamesItsServer,
	validatedAuthorizationServerIssuer,
} from "./oauth-issuer.ts";
import {
	grantForFlow,
	registrationForFlow,
	withPromotedRegistration,
	withRegistration,
} from "./registered-redirect.ts";
import type { McpClientRegistration, McpStoredAuth, McpTokenStore } from "./token-store.ts";

export interface McpOAuthProviderOptions {
	serverName: string;
	serverUrl: string;
	store: McpTokenStore;
	redirectUrl?: string | URL;
	/** This flow sends an authorize request: reuse only a stored registration naming `redirectUrl` (senpi#6327). */
	requireRegisteredRedirect?: boolean;
	scopes?: string[];
	clientId?: string;
	clientMetadataUrl?: string;
	logger?: McpLogger;
	onRedirect?: (url: URL) => void | Promise<void>;
}

// Implements the SDK OAuthClientProvider backed by the URL-bound token store.
// All persistence goes through the store so tokens survive process restarts and
// stay lockable across processes.
export class McpOAuthProvider implements OAuthClientProvider {
	readonly #options: McpOAuthProviderOptions;
	#expectedState: string | undefined;
	#lastAuthorizationUrl: URL | undefined;
	#freshAuthorization = false;
	#resource: string | undefined;
	#presentedGrant: McpStoredAuth | undefined;
	#selectedClient: McpClientRegistration | undefined;

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
			client_name: oauthBrandName(),
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
		this.#selectedClient = registrationForFlow(this.#store.read(), this.#options);
		return this.#selectedClient;
	}

	async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
		const discovery = this.discoveryState();
		const issuer =
			discovery === undefined
				? info.issuer && canonicalAuthorizationServerIssuer(info.issuer)
				: validatedAuthorizationServerIssuer(discovery, this.serverName);
		const saved = await this.#store.update((current) => {
			const next = withRegistration(current, { ...info, issuer }, this.#options);
			return current !== undefined &&
				JSON.stringify(grantBinding(current, this.grantContext)) !==
					JSON.stringify(grantBinding(next, this.grantContext))
				? { ...next, scope: undefined, refreshScope: undefined, authorization: undefined }
				: next;
		});
		this.#selectedClient = registrationForFlow(saved, this.#options);
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
		const grant = grantForFlow(this.#store.read(), this.#options);
		this.#presentedGrant = withPromotedRegistration(grant, this.#options);
		return storedAuthToTokens(grant);
	}

	async withFreshAuthorization<T>(exchange: () => Promise<T>): Promise<T> {
		const previous = this.#freshAuthorization;
		this.#freshAuthorization = true;
		try {
			return await exchange();
		} finally {
			this.#freshAuthorization = previous;
		}
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const discovery = this.discoveryState();
		// SDK results carry the exchange's issuer. Never restamp a late response from a newer file snapshot.
		const issuer =
			tokens.issuer !== undefined
				? canonicalAuthorizationServerIssuer(tokens.issuer)
				: this.#freshAuthorization && discovery !== undefined
					? validatedAuthorizationServerIssuer(discovery, this.serverName)
					: storedGrantIssuer(this.#presentedGrant);
		// A flow's staged registration replaces the signed-in client in the same write as its tokens (senpi#6327).
		const response = {
			tokens: { ...tokens, issuer },
			resource: this.#resource ?? new URL(this.serverUrl).href,
			fresh: this.#freshAuthorization,
			presented: this.#presentedGrant,
			clientInfo: this.#selectedClient ?? this.#presentedGrant?.clientInfo,
		};
		this.#presentedGrant = await this.#store.update((current) =>
			mergeOAuthTokenResponse(current ?? {}, this.grantContext, response),
		);
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
		const selected = new URL(resource ?? String(serverUrl));
		this.#resource = selected.href;
		return Promise.resolve(selected);
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
			if (scope === "tokens" || scope === "client") {
				return {
					...next,
					scope: undefined,
					refreshScope: undefined,
					authorization: undefined,
					...(scope === "client" ? { clientInfo: undefined } : {}),
				};
			}
			if (scope === "verifier") next.codeVerifier = undefined;
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
	get grantContext(): McpGrantContext {
		return {
			serverName: this.serverName,
			serverUrl: this.serverUrl,
			agentDir: this.store.agentDir,
			clientId: this.#options.clientId,
			clientMetadataUrl: this.#options.clientMetadataUrl,
		};
	}

	get #store(): McpTokenStore {
		return this.#options.store;
	}

	#logFingerprint(event: string, secret: string): void {
		this.#options.logger?.info(`oauth ${event}`, { token_fp: fingerprintSecret(secret) });
	}
}
