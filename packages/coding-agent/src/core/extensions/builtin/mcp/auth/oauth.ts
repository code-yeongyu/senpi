import type {
	OAuthClientProvider,
	OAuthDiscoveryState,
	OAuthServerInfo,
	auth as sdkAuth,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadMcpSdkAuth } from "../sdk.lazy.ts";
import { isInvalidGrant, OAuthFlowError } from "./oauth-errors.ts";
import { oauthFetch } from "./oauth-fetch.ts";
import type { McpOAuthProvider } from "./oauth-provider.ts";
import { assertS256Supported } from "./oauth-refresh.ts";

export interface OAuthFlowOptions {
	fetchFn?: FetchLike;
	discover?: (serverUrl: string) => Promise<OAuthServerInfo>;
}

export interface BeginAuthResult {
	status: "redirect" | "authorized";
	authorizationUrl: URL | undefined;
}

// Pre-flight: discover the authorization server and REFUSE (typed) if it does
// not advertise PKCE S256. Runs before any authorize redirect.
export async function assertAuthorizable(
	provider: McpOAuthProvider,
	options: OAuthFlowOptions = {},
): Promise<OAuthServerInfo> {
	const info = await discover(provider, options);
	assertS256Supported(info.authorizationServerMetadata, provider.serverName);
	return info;
}

export async function beginAuthorization(
	provider: McpOAuthProvider,
	options: OAuthFlowOptions = {},
): Promise<BeginAuthResult> {
	await assertAuthorizable(provider, options);
	const { auth } = await loadMcpSdkAuth();
	const result = await auth(provider, { serverUrl: provider.serverUrl, fetchFn: oauthFetch(options.fetchFn) });
	return {
		status: result === "AUTHORIZED" ? "authorized" : "redirect",
		authorizationUrl: provider.lastAuthorizationUrl,
	};
}

// Paste flow: validates single-use state itself, then exchanges the code.
export async function completeAuthorization(
	provider: McpOAuthProvider,
	redirectInput: string,
	options: OAuthFlowOptions = {},
): Promise<void> {
	const { code, state, iss } = parseRedirect(redirectInput, provider.serverName);
	if (!provider.consumeState(state)) {
		throw new OAuthFlowError(
			"state_mismatch",
			`MCP server ${provider.serverName} authorization state did not match (possible CSRF or a stale/replayed link); restart with /mcp auth-start.`,
			{ serverName: provider.serverName },
		);
	}
	await finishAuthorization(provider, code, options, iss);
}

// Exchange an already-validated authorization code (state was checked by the
// loopback callback server). Uses the provider's stored PKCE verifier.
export async function finishAuthorization(
	provider: McpOAuthProvider,
	code: string,
	options: OAuthFlowOptions = {},
	iss?: string,
): Promise<void> {
	assertAuthorizationResponseIssuer(provider, iss);
	let result: Awaited<ReturnType<typeof sdkAuth>>;
	const { auth } = await loadMcpSdkAuth();
	try {
		result = await auth(provider, {
			serverUrl: provider.serverUrl,
			authorizationCode: code,
			fetchFn: oauthFetch(options.fetchFn),
		});
	} catch (error) {
		if (isInvalidGrant(error) || isRejectedAuthorizationCode(error)) {
			await provider.invalidateCredentials("tokens");
			await provider.invalidateCredentials("verifier");
			throw new OAuthFlowError(
				"expired_code",
				`MCP server ${provider.serverName} authorization code was rejected or expired; restart with /mcp auth-start ${provider.serverName}.`,
				{ cause: error, serverName: provider.serverName },
			);
		}
		throw error;
	}
	if (result !== "AUTHORIZED") {
		throw new OAuthFlowError("needs_auth", `MCP server ${provider.serverName} did not complete authorization.`, {
			serverName: provider.serverName,
		});
	}
}

// RFC 9207: an authorization response that names another authorization server, or that omits `iss`
// although this server promises to send it, may have been injected by a mix-up attack; never exchange its code.
function assertAuthorizationResponseIssuer(provider: McpOAuthProvider, iss: string | undefined): void {
	const metadata = provider.discoveryState()?.authorizationServerMetadata;
	if (metadata === undefined) return;
	// The SDK keeps unknown metadata fields (loose schema) but does not type this RFC 9207 one.
	const promised =
		(metadata as { authorization_response_iss_parameter_supported?: unknown })
			.authorization_response_iss_parameter_supported === true;
	if (iss === undefined && !promised) return;
	if (iss !== undefined && iss === metadata.issuer) return;
	throw new OAuthFlowError(
		"needs_auth",
		iss === undefined
			? `MCP server ${provider.serverName} authorization response has no issuer although its authorization server promises one; restart with /mcp auth-start ${provider.serverName}.`
			: `MCP server ${provider.serverName} authorization response names another authorization server (${iss}); restart with /mcp auth-start ${provider.serverName}.`,
		{ serverName: provider.serverName },
	);
}

export async function clientCredentialsGrant(
	provider: McpOAuthProvider,
	options: OAuthFlowOptions = {},
): Promise<void> {
	const info = await discover(provider, options);
	const clientInformation = provider.clientInformation();
	if (clientInformation === undefined) {
		throw new OAuthFlowError(
			"needs_auth",
			`MCP server ${provider.serverName} client_credentials requires a clientId.`,
			{
				serverName: provider.serverName,
			},
		);
	}
	const requestedScope = provider.scopes?.join(" ");
	// Explicit delegate: spreading the class instance would drop its getters.
	const credentialsProvider: OAuthClientProvider = {
		get redirectUrl() {
			return undefined;
		},
		get clientMetadata() {
			return { ...provider.clientMetadata, scope: requestedScope };
		},
		clientInformation: () => clientInformation,
		tokens: () => undefined,
		saveTokens: () => undefined,
		redirectToAuthorization: () => undefined,
		saveCodeVerifier: () => undefined,
		codeVerifier: () => {
			throw new OAuthFlowError("no_verifier", "client_credentials has no PKCE verifier", {
				serverName: provider.serverName,
			});
		},
		prepareTokenRequest(scope?: string) {
			const params = new URLSearchParams({ grant_type: "client_credentials" });
			const requested = scope ?? requestedScope;
			if (requested !== undefined && requested.length > 0) params.set("scope", requested);
			return params;
		},
	};
	const { fetchToken } = await loadMcpSdkAuth();
	const tokens = await fetchToken(credentialsProvider, info.authorizationServerUrl, {
		metadata: info.authorizationServerMetadata,
		resource: new URL(provider.serverUrl),
		fetchFn: oauthFetch(options.fetchFn),
	});
	await provider.saveTokens(tokens);
}

export async function logout(provider: McpOAuthProvider): Promise<void> {
	await provider.store.clear();
}

async function discover(provider: McpOAuthProvider, options: OAuthFlowOptions): Promise<OAuthServerInfo> {
	if (options.discover !== undefined) return options.discover(provider.serverUrl);
	const cached = provider.discoveryState();
	if (cached !== undefined) return cached;
	const { discoverOAuthServerInfo } = await loadMcpSdkAuth();
	const info = await discoverOAuthServerInfo(provider.serverUrl, { fetchFn: oauthFetch(options.fetchFn) });
	await provider.saveDiscoveryState(toDiscoveryState(info));
	return info;
}

function toDiscoveryState(info: OAuthServerInfo): OAuthDiscoveryState {
	return {
		authorizationServerUrl: info.authorizationServerUrl,
		authorizationServerMetadata: info.authorizationServerMetadata,
		resourceMetadata: info.resourceMetadata,
	};
}

function parseRedirect(
	input: string,
	serverName: string,
): { code: string; state: string | undefined; iss: string | undefined } {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new OAuthFlowError(
			"needs_auth",
			`MCP server ${serverName} received a malformed redirect URL; paste the full http://127.0.0.1/... address from your browser.`,
			{ serverName },
		);
	}
	const error = url.searchParams.get("error");
	if (error !== null) {
		throw new OAuthFlowError("needs_auth", `MCP server ${serverName} authorization failed: ${error}`, { serverName });
	}
	const code = url.searchParams.get("code");
	if (code === null || code.length === 0) {
		throw new OAuthFlowError(
			"needs_auth",
			`MCP server ${serverName} redirect URL has no authorization code; ensure you copied the entire address.`,
			{ serverName },
		);
	}
	return { code, state: url.searchParams.get("state") ?? undefined, iss: url.searchParams.get("iss") ?? undefined };
}

function isRejectedAuthorizationCode(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return (
		message.includes("authorization code invalid") ||
		(message.includes("authorization code") && message.includes("used")) ||
		message.includes("pkce verification failed")
	);
}
