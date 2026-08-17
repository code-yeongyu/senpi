/**
 * Cursor OAuth flow (Cursor Pro/Ultra/Teams subscription).
 *
 * Cursor uses a browser deep-link + poll handshake instead of a device-code
 * or loopback-callback grant: the CLI opens
 * `https://cursor.com/loginDeepControl` with a PKCE S256 challenge and a
 * request uuid, the user approves the login in the browser, and the CLI
 * polls `https://api2.cursor.sh/auth/poll` with the uuid and PKCE verifier
 * until the tokens are released. Refresh exchanges the stored refresh token
 * (or a dashboard user API key) at `auth/exchange_user_api_key` for a fresh
 * session JWT.
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { generatePKCE } from "./pkce.ts";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_INITIAL_INTERVAL_MS = 1000;
const POLL_MAX_INTERVAL_MS = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
// ~24 minutes of wall-clock budget once the interval has backed off to its cap.
const POLL_MAX_ATTEMPTS = 150;
// Transient failures (network errors, 5xx) are tolerated while the user is
// still completing the browser step; a pending poll resets the counter.
const POLL_MAX_CONSECUTIVE_TRANSIENT_FAILURES = 3;
// Refresh slightly before the JWT `exp` so a token cannot die mid-request.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const CANCEL_MESSAGE = "Login cancelled";

type JsonObject = Record<string, unknown>;

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid Cursor OAuth response field: ${field}`);
	}
	return value;
}

/**
 * Builds a safe error detail from a Cursor error response: HTTP status plus
 * any short server-provided error strings. Never echoes the raw body, which
 * could carry token material into logs.
 */
function describeFailure(status: number, body: JsonObject | undefined): string {
	const detail = [body?.error, body?.error_description, body?.message]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join(": ");
	return `HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

async function readJsonBody(response: Response): Promise<JsonObject | undefined> {
	try {
		const parsed: unknown = await response.json();
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
	} catch {
		return undefined;
	}
}

function decodeJwtPayload(token: string): JsonObject | undefined {
	const parts = token.split(".");
	const payload = parts.length === 3 ? parts[1] : undefined;
	if (!payload) return undefined;
	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
		const parsed: unknown = JSON.parse(atob(padded));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Cursor's poll/refresh responses carry no `expires_in`; the access token is
 * a JWT whose `exp` claim is authoritative. Tokens without a readable `exp`
 * get a conservative one-hour lifetime.
 */
function accessTokenExpiry(accessToken: string, now: number): number {
	const exp = decodeJwtPayload(accessToken)?.exp;
	if (typeof exp === "number" && Number.isFinite(exp) && exp * 1000 > now) {
		return exp * 1000 - REFRESH_SKEW_MS;
	}
	return now + DEFAULT_TOKEN_LIFETIME_MS - REFRESH_SKEW_MS;
}

function credentialFromTokens(accessToken: string, refreshToken: string): OAuthCredential {
	return {
		type: "oauth",
		access: accessToken,
		refresh: refreshToken,
		expires: accessTokenExpiry(accessToken, Date.now()),
	};
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error(CANCEL_MESSAGE));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(CANCEL_MESSAGE));
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function buildCursorLoginUrl(challenge: string, uuid: string): string {
	const url = new URL(CURSOR_LOGIN_URL);
	url.searchParams.set("challenge", challenge);
	url.searchParams.set("uuid", uuid);
	url.searchParams.set("mode", "login");
	url.searchParams.set("redirectTarget", "cli");
	return url.href;
}

/**
 * Polls the token release endpoint until the user approves the browser
 * request. 404 means "not released yet". Definitive rejections (400/401/403/
 * 410) fail immediately instead of being retried as if they were network
 * hiccups; 429 and other statuses back off without burning the transient
 * failure budget the way hard errors do.
 */
async function pollForTokens(uuid: string, verifier: string, signal: AbortSignal): Promise<OAuthCredential> {
	const pollUrl = new URL(CURSOR_POLL_URL);
	pollUrl.searchParams.set("uuid", uuid);
	pollUrl.searchParams.set("verifier", verifier);

	let intervalMs = POLL_INITIAL_INTERVAL_MS;
	let consecutiveTransientFailures = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		await abortableSleep(intervalMs, signal);
		intervalMs = Math.min(intervalMs * POLL_BACKOFF_MULTIPLIER, POLL_MAX_INTERVAL_MS);

		let response: Response;
		try {
			response = await fetch(pollUrl.href, { headers: { Accept: "application/json" }, signal });
		} catch (error) {
			if (signal.aborted) throw new Error(CANCEL_MESSAGE);
			consecutiveTransientFailures++;
			if (consecutiveTransientFailures >= POLL_MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
				throw new Error(
					`Cursor login polling failed after repeated network errors: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			continue;
		}

		if (response.status === 404) {
			// Not approved yet; keep waiting.
			consecutiveTransientFailures = 0;
			continue;
		}

		if (response.ok) {
			const body = (await readJsonBody(response)) ?? {};
			return credentialFromTokens(requiredString(body, "accessToken"), requiredString(body, "refreshToken"));
		}

		if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 410) {
			const body = await readJsonBody(response);
			throw new Error(`Cursor login was rejected (${describeFailure(response.status, body)})`);
		}

		if (response.status === 429) {
			// Rate limited: the next capped-backoff wait already slows us down.
			continue;
		}

		consecutiveTransientFailures++;
		if (consecutiveTransientFailures >= POLL_MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
			const body = await readJsonBody(response);
			throw new Error(`Cursor login polling failed (${describeFailure(response.status, body)})`);
		}
	}

	throw new Error("Cursor login timed out waiting for browser approval");
}

async function loginCursor(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	interaction.signal.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();

	interaction.notify({
		type: "auth_url",
		url: buildCursorLoginUrl(challenge, uuid),
		instructions: "Approve the login request in your browser to connect your Cursor account.",
	});
	interaction.notify({ type: "progress", message: "Waiting for browser authentication..." });

	return pollForTokens(uuid, verifier, interaction.signal);
}

/**
 * Exchanges the stored refresh token (Cursor also accepts a dashboard user
 * API key here) for a fresh session JWT. Cursor may omit or rotate the
 * refresh token in the response; an omitted token keeps the previous one so
 * a non-rotating server cannot strand the credential.
 */
async function refreshCursorCredential(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const refreshToken = credential.refresh;
	if (typeof refreshToken !== "string" || refreshToken.length === 0) {
		throw new Error("Cursor token refresh failed: no refresh token stored; run login again");
	}

	let response: Response;
	try {
		response = await fetch(CURSOR_REFRESH_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${refreshToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: "{}",
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw new Error("Cursor token refresh cancelled");
		throw error;
	}

	const body = await readJsonBody(response);
	if (!response.ok) {
		throw new Error(`Cursor token refresh failed (${describeFailure(response.status, body)})`);
	}

	const access = requiredString(body ?? {}, "accessToken");
	const rotated = body?.refreshToken;
	return {
		type: "oauth",
		access,
		refresh: typeof rotated === "string" && rotated.length > 0 ? rotated : refreshToken,
		expires: accessTokenExpiry(access, Date.now()),
	};
}

export const cursorOAuth: OAuthAuth = {
	name: "Cursor (Pro/Ultra/Teams)",
	isSubscription: true,
	loginLabel: "Sign in with Cursor",
	login: loginCursor,
	refresh: refreshCursorCredential,

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
