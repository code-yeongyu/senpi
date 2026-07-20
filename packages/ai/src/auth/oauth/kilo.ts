import type { OAuthAuth } from "../types.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const KILO_DEVICE_AUTH_BASE_URL = "https://api.kilo.ai/api/device-auth";
const POLL_INTERVAL_MS = 5000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Kilo OAuth login was cancelled", "AbortError");
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
			reject(signal?.reason ?? new DOMException("Kilo OAuth login was cancelled", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function kiloFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	try {
		return await fetch(url, { ...init, signal: requestSignal(signal) });
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw new Error("Kilo device authorization request failed");
	}
}

export async function loginKilo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	throwIfAborted(callbacks.signal);
	const initiateResponse = await kiloFetch(
		`${KILO_DEVICE_AUTH_BASE_URL}/codes`,
		{ method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" } },
		callbacks.signal,
	);
	if (!initiateResponse.ok) {
		if (initiateResponse.status === 429) {
			throw new Error("Too many pending Kilo authorization requests; try again later");
		}
		throw new Error(`Kilo device authorization failed (${initiateResponse.status})`);
	}
	const initiateData = (await initiateResponse.json()) as Record<string, unknown>;
	const userCode = initiateData.code;
	const verificationUrl = initiateData.verificationUrl;
	const expiresIn = initiateData.expiresIn;
	if (
		typeof userCode !== "string" ||
		!userCode ||
		typeof verificationUrl !== "string" ||
		!verificationUrl ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error("Kilo device authorization response missing required fields");
	}

	callbacks.onAuth({ url: verificationUrl, instructions: `Enter code: ${userCode}` });
	const deadline = Date.now() + expiresIn * 1000;
	while (Date.now() < deadline) {
		throwIfAborted(callbacks.signal);
		const response = await kiloFetch(
			`${KILO_DEVICE_AUTH_BASE_URL}/codes/${encodeURIComponent(userCode)}`,
			{ headers: { Accept: "application/json" } },
			callbacks.signal,
		);
		if (response.status === 202) {
			await delay(POLL_INTERVAL_MS, callbacks.signal);
			continue;
		}
		if (response.status === 403) throw new Error("Kilo authorization was denied");
		if (response.status === 410) throw new Error("Kilo authorization code expired");
		if (!response.ok) throw new Error(`Kilo device authorization polling failed (${response.status})`);
		const data = (await response.json()) as Record<string, unknown>;
		if (data.status === "approved" && typeof data.token === "string" && data.token) {
			return { access: data.token, refresh: "", expires: Date.now() + ONE_YEAR_MS };
		}
		if (data.status === "denied") throw new Error("Kilo authorization was denied");
		if (data.status === "expired") throw new Error("Kilo authorization code expired");
		await delay(POLL_INTERVAL_MS, callbacks.signal);
	}
	throw new Error("Kilo authentication timed out");
}

export function refreshKiloToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return Promise.resolve(credentials);
}

export const kiloOAuth: OAuthAuth = {
	name: "Kilo Gateway",
	async login(callbacks) {
		const credentials = await loginKilo({
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
	refresh: async (credential) => credential,
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

export const kiloOAuthProvider: OAuthProviderInterface = {
	id: "kilo",
	name: "Kilo Gateway",
	login: loginKilo,
	refreshToken: refreshKiloToken,
	getApiKey: (credentials) => credentials.access,
};
