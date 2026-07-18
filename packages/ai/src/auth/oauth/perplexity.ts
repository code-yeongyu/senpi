import type { OAuthAuth } from "../types.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const API_VERSION = "2.18";
const NATIVE_APP_BUNDLE = "ai.perplexity.mac";
const APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const REQUEST_TIMEOUT_MS = 30_000;
const NATIVE_READ_TIMEOUT_MS = 5000;
const REFRESH_SKEW_MS = 5 * 60_000;
export const PERPLEXITY_NEVER_EXPIRES_MS = 8.64e15;

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Perplexity OAuth login was cancelled", "AbortError");
	}
}

export function getPerplexityJwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	const payload = parts[1];
	if (parts.length !== 3 || !payload) return undefined;
	try {
		const padded = payload
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const decoded = JSON.parse(atob(padded)) as { exp?: unknown };
		if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
		return decoded.exp * 1000 - REFRESH_SKEW_MS;
	} catch {
		return undefined;
	}
}

function credentialsFromJwt(jwt: string, email?: string): OAuthCredentials {
	return {
		access: jwt,
		refresh: jwt,
		expires: getPerplexityJwtExpiryMs(jwt) ?? PERPLEXITY_NEVER_EXPIRES_MS,
		...(email ? { email } : {}),
	};
}

async function extractFromNativeApp(signal?: AbortSignal): Promise<string | undefined> {
	if (typeof process === "undefined" || process.env.PI_AUTH_NO_BORROW === "1") return undefined;
	const os = await import("node:os");
	if (os.platform() !== "darwin") return undefined;
	throwIfAborted(signal);
	try {
		const { execFile } = await import("node:child_process");
		const output = await new Promise<string | undefined>((resolve) => {
			let child: ReturnType<typeof execFile> | undefined;
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				resolve(value);
			};
			const abort = () => {
				child?.kill();
				finish(undefined);
			};
			child = execFile(
				"defaults",
				["read", NATIVE_APP_BUNDLE, "authToken"],
				{ encoding: "utf8", timeout: NATIVE_READ_TIMEOUT_MS },
				(error, stdout) => finish(error ? undefined : stdout.trim()),
			);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
		return output && output !== "(null)" ? output : undefined;
	} catch {
		return undefined;
	}
}

async function endpointFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	try {
		return await fetch(url, { ...init, signal: requestSignal(signal) });
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw new Error("Perplexity authentication request failed");
	}
}

async function emailOtpLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const email = (
		await callbacks.onPrompt({
			message: "Enter your Perplexity email address",
			placeholder: "user@example.com",
		})
	).trim();
	if (!email) throw new Error("Email is required for Perplexity login");
	throwIfAborted(callbacks.signal);
	callbacks.onProgress?.("Fetching Perplexity CSRF token...");
	const headers = { "User-Agent": APP_USER_AGENT, "X-App-ApiVersion": API_VERSION };
	const csrfResponse = await endpointFetch(
		"https://www.perplexity.ai/api/auth/csrf",
		{ headers: { Accept: "application/json", ...headers } },
		callbacks.signal,
	);
	if (!csrfResponse.ok) throw new Error(`Perplexity CSRF request failed (${csrfResponse.status})`);
	const csrfData = (await csrfResponse.json()) as Record<string, unknown>;
	if (typeof csrfData.csrfToken !== "string" || !csrfData.csrfToken) {
		throw new Error("Perplexity CSRF response missing token");
	}
	const csrfCookie = readCsrfCookie(csrfResponse);

	callbacks.onProgress?.("Sending a Perplexity login code...");
	const sendResponse = await endpointFetch(
		"https://www.perplexity.ai/api/auth/signin-email",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: csrfCookie, ...headers },
			body: JSON.stringify({ email, csrfToken: csrfData.csrfToken }),
		},
		callbacks.signal,
	);
	if (!sendResponse.ok) throw new Error(`Perplexity login-code request failed (${sendResponse.status})`);

	const otp = (
		await callbacks.onPrompt({
			message: "Enter the code sent to your email",
			placeholder: "123456",
		})
	).trim();
	if (!otp) throw new Error("OTP code is required for Perplexity login");
	throwIfAborted(callbacks.signal);
	callbacks.onProgress?.("Verifying the Perplexity login code...");
	const verifyResponse = await endpointFetch(
		"https://www.perplexity.ai/api/auth/signin-otp",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: csrfCookie, ...headers },
			body: JSON.stringify({ email, otp, csrfToken: csrfData.csrfToken }),
		},
		callbacks.signal,
	);
	if (!verifyResponse.ok) throw new Error(`Perplexity OTP verification failed (${verifyResponse.status})`);
	const verifyData = (await verifyResponse.json()) as Record<string, unknown>;
	if (typeof verifyData.token !== "string" || !verifyData.token) {
		throw new Error("Perplexity OTP verification response missing token");
	}
	return credentialsFromJwt(verifyData.token, email);
}

function readCsrfCookie(response: Response): string {
	const setCookie = response.headers.get("set-cookie");
	const match = /(?:^|,\s*)((?:__Host-)?next-auth\.csrf-token=[^;,]+)/i.exec(setCookie ?? "");
	const cookie = match?.[1];
	if (cookie === undefined) throw new Error("Perplexity CSRF response missing cookie");
	return cookie;
}

export async function loginPerplexity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	throwIfAborted(callbacks.signal);
	callbacks.onProgress?.("Checking for a Perplexity desktop session...");
	const nativeJwt = await extractFromNativeApp(callbacks.signal);
	throwIfAborted(callbacks.signal);
	if (nativeJwt) {
		callbacks.onProgress?.("Found a Perplexity desktop session");
		return credentialsFromJwt(nativeJwt);
	}
	return emailOtpLogin(callbacks);
}

export async function refreshPerplexityToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.access) throw new Error("Perplexity credentials do not include a session token");
	const jwtExpiry = getPerplexityJwtExpiryMs(credentials.access);
	if (jwtExpiry !== undefined && jwtExpiry <= Date.now()) {
		throw new Error("Perplexity session expired; login again");
	}
	return {
		...credentials,
		refresh: credentials.refresh || credentials.access,
		expires: jwtExpiry ?? PERPLEXITY_NEVER_EXPIRES_MS,
	};
}

export const perplexityOAuth: OAuthAuth = {
	name: "Perplexity (Pro/Max)",
	async login(callbacks) {
		const credentials = await loginPerplexity({
			onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
			onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
			onPrompt: async (prompt) =>
				callbacks.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
			onProgress: (message) => callbacks.notify({ type: "progress", message }),
			onSelect: async () => undefined,
			signal: callbacks.signal,
		});
		return { ...credentials, type: "oauth" };
	},
	refresh: async (credential) => ({ ...(await refreshPerplexityToken(credential)), type: "oauth" }),
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

export const perplexityOAuthProvider: OAuthProviderInterface = {
	id: "perplexity",
	name: "Perplexity (Pro/Max)",
	login: loginPerplexity,
	refreshToken: refreshPerplexityToken,
	getApiKey: (credentials) => credentials.access,
};
