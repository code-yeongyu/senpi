import type { OAuthAuth } from "../../auth/types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const GITLAB_DUO_BASE_URL = "https://gitlab.com";
export const GITLAB_DUO_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
const REDIRECT_URI = "http://127.0.0.1:8080/callback";
const CALLBACK_PORT = 8080;
const SCOPE = "api";
const REFRESH_SKEW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DIRECT_ACCESS_TTL_MS = 25 * 60_000;

type Server = import("node:http").Server;
type AuthorizationInput = { code?: string; state?: string };
type DirectAccess = { token: string; headers: Record<string, string>; expiresAt: number };

const directAccessCache = new Map<string, DirectAccess>();

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parseGitLabDuoAuthorizationInput(input: string): AuthorizationInput {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		// Continue with query-string and code-only formats.
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

function tokenCredentials(payload: Record<string, unknown>, refreshFallback = ""): OAuthCredentials {
	if (typeof payload.access_token !== "string" || !payload.access_token) {
		throw new Error("GitLab OAuth token response missing access token");
	}
	const refresh =
		typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : refreshFallback;
	if (!refresh) throw new Error("GitLab OAuth token response missing refresh token");
	if (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in)) {
		throw new Error("GitLab OAuth token response missing expiry");
	}
	const createdAt =
		typeof payload.created_at === "number" && Number.isFinite(payload.created_at)
			? payload.created_at * 1000
			: Date.now();
	return {
		access: payload.access_token,
		refresh,
		expires: createdAt + payload.expires_in * 1000 - REFRESH_SKEW_MS,
	};
}

async function tokenRequest(
	body: Record<string, string>,
	refreshFallback = "",
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	let response: Response;
	try {
		response = await fetch(`${GITLAB_DUO_BASE_URL}/oauth/token`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body).toString(),
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw new Error("GitLab OAuth token request failed");
	}
	if (!response.ok) throw new Error(`GitLab OAuth token request failed (${response.status})`);
	const credentials = tokenCredentials((await response.json()) as Record<string, unknown>, refreshFallback);
	directAccessCache.clear();
	return credentials;
}

export async function getGitLabDuoDirectAccess(
	accessToken: string,
	signal?: AbortSignal,
): Promise<{ token: string; headers: Record<string, string> }> {
	if (!accessToken) throw new Error("GitLab Duo credentials do not include an access token");
	const cached = directAccessCache.get(accessToken);
	if (cached && cached.expiresAt > Date.now()) return cached;
	let response: Response;
	try {
		response = await fetch(`${GITLAB_DUO_BASE_URL}/api/v4/ai/third_party_agents/direct_access`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }),
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw new Error("GitLab Duo direct-access request failed");
	}
	if (!response.ok) throw new Error(`GitLab Duo direct-access request failed (${response.status})`);
	const data = (await response.json()) as Record<string, unknown>;
	if (typeof data.token !== "string" || !data.token || !data.headers || typeof data.headers !== "object") {
		throw new Error("GitLab Duo direct-access response missing required fields");
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(data.headers as Record<string, unknown>)) {
		if (typeof value === "string") headers[key] = value;
	}
	const directAccess = { token: data.token, headers, expiresAt: Date.now() + DIRECT_ACCESS_TTL_MS };
	directAccessCache.set(accessToken, directAccess);
	return directAccess;
}

export async function exchangeGitLabDuoAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri = REDIRECT_URI,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	return tokenRequest(
		{
			client_id: GITLAB_DUO_CLIENT_ID,
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		},
		"",
		signal,
	);
}

export async function refreshGitLabDuoToken(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!credentials.refresh) throw new Error("GitLab Duo credentials do not include a refresh token");
	return tokenRequest(
		{
			client_id: GITLAB_DUO_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
		},
		credentials.refresh,
		signal,
	);
}

function abortPromise(signal?: AbortSignal): Promise<never> | undefined {
	if (!signal) return undefined;
	return new Promise((_, reject) => {
		const rejectAbort = () =>
			reject(signal.reason ?? new DOMException("GitLab Duo OAuth login was cancelled", "AbortError"));
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
			res.end(oauthErrorHtml("Invalid GitLab OAuth callback."));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(oauthSuccessHtml("GitLab Duo authentication completed."));
		settle(code);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(CALLBACK_PORT, "127.0.0.1", resolve);
		});
		return server;
	} catch (error) {
		server.close();
		throw error;
	}
}

async function closeServer(server: Server | undefined): Promise<void> {
	if (!server?.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function loginGitLabDuo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	let settle!: (code: string) => void;
	const callbackCode = new Promise<string>((resolve) => {
		settle = resolve;
	});
	let server: Server | undefined;
	try {
		try {
			server = await startCallbackServer(state, settle);
		} catch {
			if (!callbacks.onManualCodeInput) {
				throw new Error("GitLab OAuth callback port 8080 is unavailable and manual code input is not supported");
			}
		}
		const params = new URLSearchParams({
			client_id: GITLAB_DUO_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
		});
		callbacks.onAuth({
			url: `${GITLAB_DUO_BASE_URL}/oauth/authorize?${params}`,
			instructions: "Complete GitLab login in your browser, then paste the redirect URL if needed.",
		});
		const candidates: Promise<string>[] = [];
		if (server) candidates.push(callbackCode);
		if (callbacks.onManualCodeInput) {
			candidates.push(
				callbacks.onManualCodeInput().then((input) => {
					const parsed = parseGitLabDuoAuthorizationInput(input);
					if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
					if (!parsed.code) throw new Error("Missing authorization code");
					return parsed.code;
				}),
			);
		}
		const aborted = abortPromise(callbacks.signal);
		if (aborted) candidates.push(aborted);
		const code = await Promise.race(candidates);
		return await exchangeGitLabDuoAuthorizationCode(code, verifier, REDIRECT_URI, callbacks.signal);
	} finally {
		await closeServer(server);
	}
}

export const gitlabDuoOAuth: OAuthAuth = {
	name: "GitLab Duo",
	async login(callbacks) {
		const manualAbort = new AbortController();
		try {
			const credentials = await loginGitLabDuo({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: () => {},
				onPrompt: async (prompt) =>
					callbacks.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
				onManualCodeInput: () =>
					callbacks.prompt({
						type: "manual_code",
						message: "Paste the GitLab authorization code or redirect URL:",
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
	refresh: async (credential) => ({ ...(await refreshGitLabDuoToken(credential)), type: "oauth" }),
	toAuth: async (credential) => {
		const directAccess = await getGitLabDuoDirectAccess(credential.access);
		return {
			apiKey: directAccess.token,
			headers: { ...directAccess.headers, Authorization: `Bearer ${directAccess.token}` },
		};
	},
};

export const gitlabDuoOAuthProvider: OAuthProviderInterface = {
	id: "gitlab-duo",
	name: "GitLab Duo",
	usesCallbackServer: true,
	login: loginGitLabDuo,
	refreshToken: refreshGitLabDuoToken,
	getApiKey: (credentials) => credentials.access,
};
