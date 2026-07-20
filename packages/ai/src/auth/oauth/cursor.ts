import type { OAuthAuth } from "../types.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
export const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_SKEW_MS = 5 * 60_000;

export interface CursorAuthParams {
	verifier: string;
	challenge: string;
	uuid: string;
	loginUrl: string;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Cursor OAuth login was cancelled", "AbortError");
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Cursor OAuth login was cancelled", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function getCursorTokenExpiryMs(token: string): number {
	try {
		const parts = token.split(".");
		const payload = parts[1];
		if (parts.length !== 3 || !payload) return Date.now() + 60 * 60_000;
		const padded = payload
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const decoded = JSON.parse(atob(padded)) as { exp?: unknown };
		if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
			return decoded.exp * 1000 - REFRESH_SKEW_MS;
		}
	} catch {
		// Cursor access tokens are not guaranteed to be JWTs.
	}
	return Date.now() + 60 * 60_000;
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();
	const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
	return { verifier, challenge, uuid, loginUrl: `${CURSOR_LOGIN_URL}?${params}` };
}

export async function pollCursorAuth(
	uuid: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
	let nextDelayMs = POLL_BASE_DELAY_MS;
	let consecutiveNetworkErrors = 0;
	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		throwIfAborted(signal);
		let response: Response;
		try {
			const params = new URLSearchParams({ uuid, verifier });
			response = await fetch(`${CURSOR_POLL_URL}?${params}`, { signal: requestSignal(signal) });
			consecutiveNetworkErrors = 0;
		} catch (error) {
			if (signal?.aborted) throw signal.reason ?? error;
			consecutiveNetworkErrors++;
			if (consecutiveNetworkErrors >= 3) {
				throw new Error("Cursor OAuth polling failed after repeated network errors");
			}
			await delay(nextDelayMs, signal);
			nextDelayMs = Math.min(nextDelayMs * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
			continue;
		}

		if (response.status === 404) {
			await delay(nextDelayMs, signal);
			nextDelayMs = Math.min(nextDelayMs * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
			continue;
		}
		if (!response.ok) throw new Error(`Cursor OAuth polling failed (${response.status})`);
		const data = (await response.json()) as Record<string, unknown>;
		if (typeof data.accessToken !== "string" || !data.accessToken) {
			throw new Error("Cursor OAuth polling response missing access token");
		}
		if (typeof data.refreshToken !== "string" || !data.refreshToken) {
			throw new Error("Cursor OAuth polling response missing refresh token");
		}
		return { accessToken: data.accessToken, refreshToken: data.refreshToken };
	}
	throw new Error("Cursor OAuth polling timed out");
}

export async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	throwIfAborted(callbacks.signal);
	const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
	callbacks.onAuth({ url: loginUrl, instructions: "Complete Cursor login in your browser." });
	callbacks.onProgress?.("Waiting for Cursor authentication...");
	const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier, callbacks.signal);
	return { access: accessToken, refresh: refreshToken, expires: getCursorTokenExpiryMs(accessToken) };
}

export async function refreshCursorToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	if (!refreshToken) throw new Error("Cursor credentials do not include a refresh token");
	let response: Response;
	try {
		response = await fetch(CURSOR_REFRESH_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${refreshToken}`, "Content-Type": "application/json" },
			body: "{}",
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw new Error("Cursor token refresh request failed");
	}
	if (!response.ok) throw new Error(`Cursor token refresh failed (${response.status})`);
	const data = (await response.json()) as Record<string, unknown>;
	if (typeof data.accessToken !== "string" || !data.accessToken) {
		throw new Error("Cursor token refresh response missing access token");
	}
	const refresh = typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : refreshToken;
	return { access: data.accessToken, refresh, expires: getCursorTokenExpiryMs(data.accessToken) };
}

export const cursorOAuth: OAuthAuth = {
	name: "Cursor (Claude, GPT, etc.)",
	async login(callbacks) {
		const credentials = await loginCursor({
			onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
			onDeviceCode: () => {},
			onPrompt: async (prompt) =>
				callbacks.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
			onProgress: (message) => callbacks.notify({ type: "progress", message }),
			onSelect: async () => undefined,
			signal: callbacks.signal,
		});
		return { ...credentials, type: "oauth" };
	},
	refresh: async (credential) => ({ ...(await refreshCursorToken(credential.refresh)), type: "oauth" }),
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

export const cursorOAuthProvider: OAuthProviderInterface = {
	id: "cursor",
	name: "Cursor (Claude, GPT, etc.)",
	login: loginCursor,
	refreshToken: (credentials) => refreshCursorToken(credentials.refresh),
	getApiKey: (credentials) => credentials.access,
};
