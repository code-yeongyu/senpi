/**
 * OpenAI Responses API token sharing through Sign in with ChatGPT.
 *
 * This public-client flow uses no client secret and sends the resulting user
 * access token directly to api.openai.com.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
import { OAuthTokenEndpointError } from "../../utils/oauth-refresh-error.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { LoginOptions, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { createOpenAIIdTokenVerifier, type OpenAIIdTokenDependencies } from "./openai-id-token.ts";
import { generatePKCE } from "./pkce.ts";

// Only first-time registration uses this entrypoint; returning accounts keep their issued ID.
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME_HINT = "Pi";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Refresh this long before the real expiry so a request never starts with a token about to expire.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

type AuthorizationResult = {
	code: string;
	clientId: string;
};

type CallbackServer = {
	server: Server;
	result: Promise<AuthorizationResult>;
};

type TokenResponse = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	id_token?: unknown;
	scope?: unknown;
};

class OpenAIReauthorizationError extends Error {
	readonly code: "invalid_account" | "client_mismatch" | "subject_mismatch";

	constructor(code: "invalid_account" | "client_mismatch" | "subject_mismatch") {
		super(
			code === "invalid_account"
				? "The selected ChatGPT account needs an issued client ID and verified subject"
				: code === "client_mismatch"
					? "ChatGPT reauthorization returned a different client ID"
					: "ChatGPT reauthorization returned a different account",
		);
		this.name = "OpenAIReauthorizationError";
		this.code = code;
	}
}

class OpenAIConsentDeclinedError extends Error {
	readonly code = "consent_declined";

	constructor() {
		super("ChatGPT consent declined");
		this.name = "OpenAIConsentDeclinedError";
	}
}

class OpenAIPlanUsageNotEnabledError extends Error {
	readonly code = "plan_usage_not_enabled";
	readonly recovery = ["enable_plan_usage", "use_api_key"] as const;

	constructor() {
		super("ChatGPT plan usage is not enabled. Enable ChatGPT plan usage or use an API key.");
		this.name = "OpenAIPlanUsageNotEnabledError";
	}
}

/** A client ID the callback must carry: the saved one on reauthorization, the issued one on a plan-usage consent re-run. */
type KnownClient = { clientId: string; purpose: "reauthorize" | "consent" };

function randomValue(): string {
	return randomBytes(32).toString("base64url");
}

function authorizationResultFromCallback(
	url: URL,
	expectedState: string,
	knownClient?: KnownClient,
): AuthorizationResult {
	const state = url.searchParams.get("state");
	if (!state) throw new Error("Missing OAuth state");
	if (state !== expectedState) throw new Error("OAuth state mismatch");
	const error = url.searchParams.get("error");
	if (error === "access_denied") throw new OpenAIConsentDeclinedError();
	if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
	const code = url.searchParams.get("code");
	if (!code) throw new Error("Missing authorization code");
	const suppliedClientId = url.searchParams.get("client_id");
	if (
		knownClient?.purpose === "reauthorize" &&
		suppliedClientId !== null &&
		suppliedClientId !== knownClient.clientId
	) {
		throw new OpenAIReauthorizationError("client_mismatch");
	}
	const callbackClientId = suppliedClientId?.trim();
	if (knownClient?.purpose === "consent" && callbackClientId && callbackClientId !== knownClient.clientId) {
		throw new Error("ChatGPT consent callback client ID mismatch");
	}
	const clientId = knownClient?.clientId ?? callbackClientId;
	if (!clientId) throw new Error("OpenAI OAuth registration callback did not contain an issued client ID");
	return { code, clientId };
}

function authorizationResultFromManualInput(
	input: string,
	expectedState: string,
	knownClient?: KnownClient,
): AuthorizationResult {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Paste the full callback URL from the browser");
	}
	const expected = new URL(REDIRECT_URI);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
		throw new Error(`The pasted callback URL must start with ${REDIRECT_URI}`);
	}
	return authorizationResultFromCallback(url, expectedState, knownClient);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	response.end(body);
}

function startCallbackServer(expectedState: string, knownClient?: KnownClient): Promise<CallbackServer> {
	return new Promise((resolve, reject) => {
		let resolveResult!: (result: AuthorizationResult) => void;
		let rejectResult!: (error: Error) => void;
		const result = new Promise<AuthorizationResult>((resolveAuthorization, rejectAuthorization) => {
			resolveResult = resolveAuthorization;
			rejectResult = rejectAuthorization;
		});

		const server = createServer((request, response) => {
			try {
				const url = new URL(request.url || "", REDIRECT_URI);
				if (url.pathname !== CALLBACK_PATH) {
					sendHtml(response, 404, oauthErrorHtml("Callback route not found."));
					return;
				}

				let authorizationResult: AuthorizationResult;
				try {
					authorizationResult = authorizationResultFromCallback(url, expectedState, knownClient);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Invalid callback";
					sendHtml(response, 400, oauthErrorHtml(message));
					// Unrelated callbacks must not stop the pending login attempt.
					if (
						error instanceof OpenAIReauthorizationError ||
						(url.searchParams.get("state") === expectedState && url.searchParams.has("error"))
					) {
						rejectResult(error instanceof Error ? error : new Error(message));
					}
					return;
				}

				sendHtml(response, 200, oauthSuccessHtml("ChatGPT authentication completed. You can close this window."));
				resolveResult(authorizationResult);
			} catch {
				sendHtml(response, 500, oauthErrorHtml("Internal error while processing the callback."));
			}
		});

		server.once("error", reject);
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			server.removeListener("error", reject);
			server.on("error", rejectResult);
			resolve({ server, result });
		});
	});
}

async function requestToken(
	body: URLSearchParams,
	signal: AbortSignal,
	fetchToken: OpenAIIdTokenDependencies["fetch"],
): Promise<TokenResponse> {
	const response = await fetchToken(TOKEN_URL, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
		signal,
	});
	if (!response.ok) {
		const responseBody = await response.text().catch(() => "");
		throw new OAuthTokenEndpointError(
			`OpenAI OAuth token request failed (${response.status}): ${responseBody || response.statusText}`,
			response.status,
		);
	}
	const data: unknown = await response.json();
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("OpenAI OAuth token response must be an object");
	}
	return data as TokenResponse;
}

function requireTokenString(value: unknown, field: "access_token" | "refresh_token" | "scope"): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`OpenAI OAuth token response has invalid ${field}`);
	}
	return value;
}

function credentialFromTokenResponse(token: TokenResponse, clientId: string, now: () => number): OAuthCredential {
	const access = requireTokenString(token.access_token, "access_token");
	const refresh = requireTokenString(token.refresh_token, "refresh_token");
	const scope = requireTokenString(token.scope, "scope");
	if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
		throw new Error("OpenAI OAuth token response has invalid expires_in");
	}
	const scopes = scope.trim().split(/\s+/).filter(Boolean);
	return {
		type: "oauth",
		access,
		refresh,
		expires: now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
		clientId,
		scopes,
		planUsageEnabled: scopes.includes(DIRECT_TOKEN_SCOPE),
	};
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	clientId: string,
	signal: AbortSignal,
	nonce: string,
	deps: OpenAIIdTokenDependencies,
	verifyIdToken: ReturnType<typeof createOpenAIIdTokenVerifier>,
): Promise<OAuthCredential> {
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
		}),
		signal,
		deps.fetch,
	);
	const identity = await verifyIdToken(token.id_token, clientId, nonce, signal);
	return { ...credentialFromTokenResponse(token, clientId, deps.now), ...identity, idToken: token.id_token as string };
}

async function refreshAccessToken(
	credential: OAuthCredential,
	signal: AbortSignal,
	deps: OpenAIIdTokenDependencies,
): Promise<OAuthCredential> {
	const clientId = credential.clientId;
	if (typeof clientId !== "string" || clientId.trim().length === 0) {
		throw new Error("Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT");
	}
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			refresh_token: credential.refresh,
			resource: RESOURCE,
		}),
		signal,
		deps.fetch,
	);
	return { ...credential, ...credentialFromTokenResponse(token, clientId, deps.now) };
}

/** OpenAI identifies each installation ("agent host") by a stable URI such as `urn:uuid:<uuid>`. */
function agentHostId(deviceId: string | undefined): string {
	if (!deviceId || !UUID_PATTERN.test(deviceId)) {
		throw new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation");
	}
	return `urn:uuid:${deviceId.toLowerCase()}`;
}

async function loginOpenAIChatGPT(
	interaction: ProviderAuthInteraction,
	options: LoginOptions | undefined,
	deps: OpenAIIdTokenDependencies,
	verifyIdToken: ReturnType<typeof createOpenAIIdTokenVerifier>,
): Promise<OAuthCredential> {
	const existing = options?.reauthorize;
	if (
		existing &&
		(typeof existing.clientId !== "string" ||
			!existing.clientId.trim() ||
			existing.clientId === DYNAMIC_CLIENT_ID ||
			typeof existing.subject !== "string" ||
			!existing.subject.trim())
	) {
		throw new OpenAIReauthorizationError("invalid_account");
	}
	const pendingClientId = existing?.clientId;
	const hostId = agentHostId(options?.getDeviceId?.());
	const consentClientId = options?.planUsageConsent?.clientId;
	if (options?.planUsageConsent && (!consentClientId?.trim() || consentClientId === DYNAMIC_CLIENT_ID)) {
		throw new Error("Enabling ChatGPT plan usage requires the saved issued client ID");
	}
	const knownClient: KnownClient | undefined = pendingClientId
		? { clientId: pendingClientId, purpose: "reauthorize" }
		: consentClientId
			? { clientId: consentClientId, purpose: "consent" }
			: undefined;
	const { verifier, challenge } = await generatePKCE();
	const state = randomValue();
	const nonce = randomValue();
	let callback: CallbackServer | undefined;
	try {
		callback = await startCallbackServer(state, knownClient);
	} catch (error) {
		interaction.notify({
			type: "info",
			message: `Could not listen on ${REDIRECT_URI}; paste the final redirect URL to continue. ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	const authorizationUrl = new URL(AUTHORIZE_URL);
	authorizationUrl.search = new URLSearchParams({
		client_id: pendingClientId ?? DYNAMIC_CLIENT_ID,
		ext_agent_host_id: hostId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
		scope: SCOPE,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		nonce,
	}).toString();
	if (existing) {
		if (existing.idToken) authorizationUrl.searchParams.set("id_token_hint", existing.idToken);
		if (existing.email) authorizationUrl.searchParams.set("login_hint", existing.email);
	} else {
		authorizationUrl.searchParams.set("agent_name_hint", AGENT_NAME_HINT);
	}
	if (consentClientId) {
		authorizationUrl.searchParams.set("client_id", consentClientId);
		authorizationUrl.searchParams.set("prompt", "consent");
	}
	interaction.notify({
		type: "auth_url",
		url: authorizationUrl.toString(),
		instructions:
			"Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
	});

	const manualAbort = new AbortController();
	const manualCode = interaction
		.prompt({
			type: "manual_code",
			message: "Complete login in your browser, or paste the final redirect URL here:",
			placeholder: REDIRECT_URI,
			signal: AbortSignal.any([manualAbort.signal, interaction.signal]),
		})
		.then((input) => authorizationResultFromManualInput(input, state, knownClient));

	try {
		const result = await (callback ? Promise.race([callback.result, manualCode]) : manualCode);
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const credential = await exchangeAuthorizationCode(
			result.code,
			verifier,
			result.clientId,
			interaction.signal,
			nonce,
			deps,
			verifyIdToken,
		);
		if (existing && credential.subject !== existing.subject) {
			throw new OpenAIReauthorizationError("subject_mismatch");
		}
		return credential;
	} catch (error) {
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		throw error;
	} finally {
		manualAbort.abort();
		callback?.server.close();
		// close() only stops accepting new connections. Browsers open spare connections ahead of
		// time, and one that has not sent a request yet stays open and attached to this server.
		// A later login in the same process starts a new server with a new state, but the browser
		// may send that login's callback over the spare connection. This server would then handle
		// it and reject it with "OAuth state mismatch", and the new login would never see it.
		callback?.server.closeAllConnections();
	}
}

export function createOpenAIChatGPTOAuth(dependencies: Partial<OpenAIIdTokenDependencies> = {}): OAuthAuth {
	const deps: OpenAIIdTokenDependencies = {
		fetch: dependencies.fetch ?? ((url, init) => fetch(url, init)),
		now: dependencies.now ?? (() => Date.now()),
	};
	const verifyIdToken = createOpenAIIdTokenVerifier(deps);
	return {
		name: "OpenAI (ChatGPT subscription)",
		isSubscription: true,
		loginLabel: "Sign in with ChatGPT",
		login: (interaction, options) => loginOpenAIChatGPT(interaction, options, deps, verifyIdToken),
		refresh: (credential, signal) => refreshAccessToken(credential, signal, deps),
		async toAuth(credential) {
			if (credential.planUsageEnabled === false || !credential.scopes?.includes(DIRECT_TOKEN_SCOPE)) {
				throw new OpenAIPlanUsageNotEnabledError();
			}
			return { apiKey: credential.access };
		},
	};
}

export const openaiChatGPTOAuth = createOpenAIChatGPTOAuth();
