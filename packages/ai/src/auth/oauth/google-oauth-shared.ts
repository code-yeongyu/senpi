import type { OAuthAuth } from "../types.ts";
import { createGoogleOAuthServer, type GoogleOAuthServer } from "./google-oauth-node.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface GoogleOAuthConfig {
	id: string;
	name: string;
	clientId: string;
	clientSecret: string;
	port: number;
	path: string;
	scopes: string[];
	discoverProject(accessToken: string, signal?: AbortSignal): Promise<string>;
}

const requestSignal = (signal?: AbortSignal) =>
	signal
		? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
const redirectUri = (config: GoogleOAuthConfig) => `http://127.0.0.1:${config.port}${config.path}`;

function requireProjectId(value: unknown, provider: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${provider} credentials are missing projectId`);
	return value;
}

async function tokenRequest(
	config: GoogleOAuthConfig,
	body: Record<string, string>,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
		signal: requestSignal(signal),
	});
	if (!response.ok) throw new Error(`${config.name} token request failed (${response.status})`);
	const data = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
	if (typeof data.access_token !== "string" || !data.access_token) {
		throw new Error(`${config.name} token response missing access token`);
	}
	const refresh =
		typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : body.refresh_token;
	if (!refresh) throw new Error(`${config.name} token response missing refresh token`);
	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
	return { access: data.access_token, refresh, expires: Date.now() + expiresIn * 1000 - SKEW_MS };
}

export async function refreshGoogleToken(
	config: GoogleOAuthConfig,
	refresh: string,
	projectId: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!refresh) throw new Error(`${config.name} credentials do not include a refresh token`);
	const project = requireProjectId(projectId, config.name);
	return {
		...(await tokenRequest(
			config,
			{
				client_id: config.clientId,
				client_secret: config.clientSecret,
				refresh_token: refresh,
				grant_type: "refresh_token",
			},
			signal,
		)),
		projectId: project,
	};
}

export function parseGoogleAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		const params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
		if (params.has("code")) return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
		return { code: value };
	}
}

async function startCallbackServer(
	config: GoogleOAuthConfig,
	state: string,
	settle: (code: string) => void,
): Promise<GoogleOAuthServer> {
	const server = createGoogleOAuthServer((req, res) => {
		const url = new URL(req.url ?? "", redirectUri(config));
		const code = url.searchParams.get("code");
		if (url.pathname !== config.path || url.searchParams.get("state") !== state || !code) {
			res.writeHead(400, { "Content-Type": "text/html" });
			res.end(oauthErrorHtml("Invalid Google OAuth callback."));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(oauthSuccessHtml("Google authentication completed."));
		settle(code);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(config.port, "127.0.0.1", resolve);
		});
		return server;
	} catch (error) {
		server.close();
		throw error;
	}
}

export async function loginGoogle(
	config: GoogleOAuthConfig,
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	if (callbacks.signal?.aborted) throw callbacks.signal.reason ?? new DOMException("Cancelled", "AbortError");
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	let settle!: (code: string) => void;
	const callbackCode = new Promise<string>((resolve) => {
		settle = resolve;
	});
	let server: GoogleOAuthServer | undefined;
	try {
		try {
			server = await startCallbackServer(config, state, settle);
		} catch {
			if (!callbacks.onManualCodeInput) {
				throw new Error(
					`${config.name} callback port ${config.port} is unavailable and manual input is unsupported`,
				);
			}
		}
		const params = new URLSearchParams({
			client_id: config.clientId,
			response_type: "code",
			redirect_uri: redirectUri(config),
			scope: config.scopes.join(" "),
			state,
			access_type: "offline",
			prompt: "consent",
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		callbacks.onAuth({
			url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
			instructions: "Complete sign-in, then paste the redirect URL if the callback does not complete.",
		});
		const candidates: Promise<string>[] = [];
		if (server) candidates.push(callbackCode);
		if (callbacks.onManualCodeInput) {
			candidates.push(
				callbacks.onManualCodeInput().then((input) => {
					const parsed = parseGoogleAuthorizationInput(input);
					if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
					if (!parsed.code) throw new Error("Missing authorization code");
					return parsed.code;
				}),
			);
		}
		const loginSignal = callbacks.signal
			? AbortSignal.any([callbacks.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)])
			: AbortSignal.timeout(LOGIN_TIMEOUT_MS);
		candidates.push(
			new Promise<never>((_, reject) => {
				const abort = () => reject(loginSignal.reason ?? new DOMException("Cancelled", "AbortError"));
				if (loginSignal.aborted) abort();
				else loginSignal.addEventListener("abort", abort, { once: true });
			}),
		);
		const code = await Promise.race(candidates);
		const credentials = await tokenRequest(
			config,
			{
				client_id: config.clientId,
				client_secret: config.clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: redirectUri(config),
				code_verifier: verifier,
			},
			callbacks.signal,
		);
		const projectId = requireProjectId(
			await config.discoverProject(credentials.access, callbacks.signal),
			config.name,
		);
		return { ...credentials, projectId };
	} finally {
		server?.close();
	}
}

export function googleOAuthExports(config: GoogleOAuthConfig): { auth: OAuthAuth; provider: OAuthProviderInterface } {
	const auth: OAuthAuth = {
		name: config.name,
		login: async (callbacks) => {
			const manualAbort = new AbortController();
			try {
				const credentials = await loginGoogle(config, {
					onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
					onDeviceCode: () => {},
					onPrompt: async () => "",
					onManualCodeInput: () =>
						callbacks.prompt({
							type: "manual_code",
							message: "Paste the Google authorization code or redirect URL:",
							placeholder: redirectUri(config),
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
		refresh: async (credential) => ({
			...(await refreshGoogleToken(config, credential.refresh, requireProjectId(credential.projectId, config.name))),
			type: "oauth",
		}),
		toAuth: async (credential) => ({
			apiKey: JSON.stringify({
				token: credential.access,
				projectId: requireProjectId(credential.projectId, config.name),
			}),
		}),
	};
	return {
		auth,
		provider: {
			id: config.id,
			name: config.name,
			usesCallbackServer: true,
			login: (callbacks) => loginGoogle(config, callbacks),
			refreshToken: (credentials) =>
				refreshGoogleToken(config, credentials.refresh, requireProjectId(credentials.projectId, config.name)),
			getApiKey: (credentials) =>
				JSON.stringify({
					token: credentials.access,
					projectId: requireProjectId(credentials.projectId, config.name),
				}),
		},
	};
}
