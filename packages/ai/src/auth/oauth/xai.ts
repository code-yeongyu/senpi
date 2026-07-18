import type { OAuthAuth } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const REDIRECT_URI = "http://127.0.0.1:56121/callback";
const SKEW_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

type Server = import("node:http").Server;
type Endpoints = { authorizationEndpoint: string; tokenEndpoint: string };
type AuthorizationInput = { code?: string; state?: string };

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validateEndpoint(value: unknown): string {
	if (typeof value !== "string") throw new Error("xAI OAuth discovery response is missing an endpoint");
	const url = new URL(value);
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error("xAI OAuth discovery returned an unexpected endpoint");
	}
	return url.toString();
}

export function parseXaiAuthorizationInput(input: string): AuthorizationInput {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		// Continue with non-URL callback formats.
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code: code || undefined, state: state || undefined };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

export async function discoverXaiOAuthEndpoints(signal?: AbortSignal): Promise<Endpoints> {
	const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
		headers: { Accept: "application/json" },
		signal: requestSignal(signal),
	});
	if (!response.ok) throw new Error(`xAI OAuth discovery failed (${response.status})`);
	const data = (await response.json()) as Record<string, unknown>;
	return {
		authorizationEndpoint: validateEndpoint(data.authorization_endpoint),
		tokenEndpoint: validateEndpoint(data.token_endpoint),
	};
}

async function tokenRequest(
	endpoint: string,
	body: Record<string, string>,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body).toString(),
		signal: requestSignal(signal),
	});
	if (!response.ok) throw new Error(`xAI token request failed (${response.status})`);
	const data = (await response.json()) as Record<string, unknown>;
	if (typeof data.access_token !== "string" || !data.access_token)
		throw new Error("xAI token response missing access token");
	const refresh =
		typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : body.refresh_token;
	if (!refresh) throw new Error("xAI token response missing refresh token");
	const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : 3600;
	return { access: data.access_token, refresh, expires: Date.now() + expiresIn * 1000 - SKEW_MS };
}

export async function exchangeXaiAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri = REDIRECT_URI,
	signal?: AbortSignal,
) {
	const { tokenEndpoint } = await discoverXaiOAuthEndpoints(signal);
	return tokenRequest(
		tokenEndpoint,
		{
			grant_type: "authorization_code",
			client_id: XAI_OAUTH_CLIENT_ID,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		},
		signal,
	);
}

export async function refreshXaiToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	if (!refreshToken) throw new Error("xAI credentials do not include a refresh token");
	const { tokenEndpoint } = await discoverXaiOAuthEndpoints(signal);
	return tokenRequest(
		tokenEndpoint,
		{ grant_type: "refresh_token", client_id: XAI_OAUTH_CLIENT_ID, refresh_token: refreshToken },
		signal,
	);
}

function abortPromise(signal?: AbortSignal): Promise<never> | undefined {
	if (!signal) return undefined;
	return new Promise((_, reject) => {
		const rejectAbort = () =>
			reject(signal.reason ?? new DOMException("xAI OAuth login was cancelled", "AbortError"));
		if (signal.aborted) rejectAbort();
		else signal.addEventListener("abort", rejectAbort, { once: true });
	});
}

async function startCallbackServer(state: string, settle: (code: string) => void): Promise<Server> {
	const { createServer } = await import("node:http");
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "", REDIRECT_URI);
		const code = url.searchParams.get("code");
		if (url.pathname !== "/callback" || url.searchParams.get("state") !== state || !code) {
			res.writeHead(400, { "Content-Type": "text/html" });
			res.end(oauthErrorHtml("Invalid xAI OAuth callback."));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(oauthSuccessHtml("xAI authentication completed."));
		settle(code);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(56121, "127.0.0.1", resolve);
		});
		return server;
	} catch (error) {
		server.close();
		throw error;
	}
}

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const endpoints = await discoverXaiOAuthEndpoints(callbacks.signal);
	let settle!: (code: string) => void;
	const callbackCode = new Promise<string>((resolve) => {
		settle = resolve;
	});
	let server: Server | undefined;
	try {
		try {
			server = await startCallbackServer(state, settle);
		} catch {
			if (!callbacks.onManualCodeInput)
				throw new Error("xAI OAuth callback port 56121 is unavailable and manual code input is not supported");
		}
		const params = new URLSearchParams({
			response_type: "code",
			client_id: XAI_OAUTH_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			nonce: crypto.randomUUID(),
		});
		callbacks.onAuth({
			url: `${endpoints.authorizationEndpoint}?${params}`,
			instructions:
				"Complete xAI/Grok login in your browser, then paste the redirect URL or authorization code if needed.",
		});
		const candidates: Promise<string>[] = [];
		if (server) candidates.push(callbackCode);
		if (callbacks.onManualCodeInput) {
			candidates.push(
				callbacks.onManualCodeInput().then((input) => {
					const parsed = parseXaiAuthorizationInput(input);
					if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
					if (!parsed.code) throw new Error("Missing authorization code");
					return parsed.code;
				}),
			);
		}
		const aborted = abortPromise(callbacks.signal);
		if (aborted) candidates.push(aborted);
		const code = await Promise.race(candidates);
		return await tokenRequest(
			endpoints.tokenEndpoint,
			{
				grant_type: "authorization_code",
				client_id: XAI_OAUTH_CLIENT_ID,
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: verifier,
			},
			callbacks.signal,
		);
	} finally {
		server?.close();
	}
}

export const xaiOAuth: OAuthAuth = {
	name: "xAI (Grok account)",
	async login(callbacks) {
		const manualAbort = new AbortController();
		try {
			const credentials = await loginXai({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: () => {},
				onPrompt: async (prompt) =>
					callbacks.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
				onManualCodeInput: () =>
					callbacks.prompt({
						type: "manual_code",
						message: "Paste the xAI authorization code or redirect URL:",
						placeholder: REDIRECT_URI,
						signal: manualAbort.signal,
					}),
				onSelect: async () => undefined,
				signal: callbacks.signal,
			});
			return { ...credentials, type: "oauth" };
		} finally {
			manualAbort.abort();
		}
	},
	refresh: async (credential) => ({ ...(await refreshXaiToken(credential.refresh)), type: "oauth" }),
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (Grok account)",
	usesCallbackServer: true,
	login: loginXai,
	refreshToken: (credentials) => refreshXaiToken(credentials.refresh),
	getApiKey: (credentials) => credentials.access,
};
