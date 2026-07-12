import type { OAuthAuth } from "../../auth/types.ts";
import { getProviderEnvValue } from "../provider-env.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_ID_FILENAME = "kimi-device-id";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_FLOW_TTL_SECONDS = 15 * 60;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KIMI_CLIENT_VERSION = "1.5";

interface DeviceAuthorizationResponse {
	user_code?: unknown;
	device_code?: unknown;
	verification_uri?: unknown;
	verification_uri_complete?: unknown;
	expires_in?: unknown;
	interval?: unknown;
}

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	error?: unknown;
	interval?: unknown;
}

export interface KimiCommonHeaders {
	"User-Agent": string;
	"X-Msh-Platform": string;
	"X-Msh-Version": string;
	"X-Msh-Device-Name": string;
	"X-Msh-Device-Model": string;
	"X-Msh-Os-Version": string;
	"X-Msh-Device-Id": string;
}

let commonHeadersPromise: Promise<Readonly<KimiCommonHeaders>> | undefined;

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validateKimiUrl(value: unknown, label: string): URL {
	if (typeof value !== "string" || !value) throw new Error(`Kimi OAuth response is missing ${label}`);
	const url = new URL(value);
	const host = url.hostname.toLowerCase();
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		(host !== "kimi.com" && !host.endsWith(".kimi.com"))
	) {
		throw new Error(`Kimi OAuth returned an unexpected ${label}`);
	}
	return url;
}

function resolveOAuthHost(): string {
	const configured = getProviderEnvValue("KIMI_CODE_OAUTH_HOST") || getProviderEnvValue("KIMI_OAUTH_HOST");
	const url = validateKimiUrl(configured || DEFAULT_OAUTH_HOST, "OAuth host");
	if (url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Kimi OAuth returned an unexpected OAuth host");
	}
	return url.origin;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readDeviceId(): Promise<string> {
	const [{ mkdir, readFile, writeFile, chmod }, os, path] = await Promise.all([
		import("node:fs/promises"),
		import("node:os"),
		import("node:path"),
	]);
	const agentDir =
		getProviderEnvValue("SENPI_CODING_AGENT_DIR") ||
		getProviderEnvValue("PI_CODING_AGENT_DIR") ||
		path.join(os.homedir(), ".senpi", "agent");
	const deviceIdPath = path.join(agentDir, DEVICE_ID_FILENAME);
	await mkdir(agentDir, { recursive: true, mode: 0o700 });

	try {
		const existing = (await readFile(deviceIdPath, "utf8")).trim();
		if (/^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
	} catch (error) {
		if (!isNodeErrorCode(error, "ENOENT")) throw error;
	}

	const deviceId = crypto.randomUUID().replace(/-/g, "");
	try {
		await writeFile(deviceIdPath, `${deviceId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if (!isNodeErrorCode(error, "EEXIST")) throw error;
		const existing = (await readFile(deviceIdPath, "utf8")).trim();
		if (/^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
		await writeFile(deviceIdPath, `${deviceId}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(deviceIdPath, 0o600);
	}
	return deviceId;
}

export function getKimiCommonHeaders(): Promise<Readonly<KimiCommonHeaders>> {
	commonHeadersPromise ??= (async () => {
		const os = await import("node:os");
		const deviceId = await readDeviceId();
		return Object.freeze({
			"User-Agent": `KimiCLI/${KIMI_CLIENT_VERSION}`,
			"X-Msh-Platform": "kimi_cli",
			"X-Msh-Version": KIMI_CLIENT_VERSION,
			"X-Msh-Device-Name": os.hostname(),
			"X-Msh-Device-Model": `${os.platform()} ${os.release()} ${os.arch()}`,
			"X-Msh-Os-Version": os.version(),
			"X-Msh-Device-Id": deviceId,
		});
	})();
	return commonHeadersPromise;
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
	const value = await response.json().catch(() => undefined);
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

async function requestDeviceAuthorization(signal?: AbortSignal): Promise<{
	userCode: string;
	deviceCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}> {
	const response = await fetch(`${resolveOAuthHost()}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			...(await getKimiCommonHeaders()),
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
		signal: requestSignal(signal),
	});
	const payload = (await readJsonObject(response)) as DeviceAuthorizationResponse;
	if (!response.ok) throw new Error(`Kimi device authorization failed (${response.status})`);
	if (typeof payload.user_code !== "string" || typeof payload.device_code !== "string") {
		throw new Error("Kimi device authorization response missing required fields");
	}
	const verificationUri = validateKimiUrl(payload.verification_uri, "verification URI").toString();
	const verificationUriComplete =
		payload.verification_uri_complete === undefined
			? verificationUri
			: validateKimiUrl(payload.verification_uri_complete, "complete verification URI").toString();
	const expiresInSeconds =
		typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0
			? payload.expires_in
			: DEFAULT_DEVICE_FLOW_TTL_SECONDS;
	const intervalSeconds =
		typeof payload.interval === "number" && Number.isFinite(payload.interval) && payload.interval > 0
			? payload.interval
			: DEFAULT_POLL_INTERVAL_SECONDS;
	return {
		userCode: payload.user_code,
		deviceCode: payload.device_code,
		verificationUri,
		verificationUriComplete,
		expiresInSeconds,
		intervalSeconds,
	};
}

function parseTokenPayload(payload: TokenResponse, refreshTokenFallback?: string): OAuthCredentials {
	if (
		typeof payload.access_token !== "string" ||
		!payload.access_token ||
		typeof payload.expires_in !== "number" ||
		!Number.isFinite(payload.expires_in) ||
		payload.expires_in <= 0
	) {
		throw new Error("Kimi token response missing required fields");
	}
	const refresh =
		typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : refreshTokenFallback;
	if (!refresh) throw new Error("Kimi token response missing refresh token");
	return {
		access: payload.access_token,
		refresh,
		expires: Date.now() + payload.expires_in * 1000 - OAUTH_EXPIRY_SKEW_MS,
	};
}

async function pollForToken(
	deviceCode: string,
	intervalSeconds: number,
	expiresInSeconds: number,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds,
		expiresInSeconds,
		signal,
		poll: async () => {
			const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
					...(await getKimiCommonHeaders()),
				},
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}).toString(),
				signal: requestSignal(signal),
			});
			const payload = (await readJsonObject(response)) as TokenResponse;
			if (response.ok && typeof payload.access_token === "string") {
				return { status: "complete", value: parseTokenPayload(payload) };
			}
			const error = typeof payload.error === "string" ? payload.error : undefined;
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") {
				return {
					status: "slow_down",
					intervalSeconds:
						typeof payload.interval === "number" && Number.isFinite(payload.interval) && payload.interval > 0
							? payload.interval
							: undefined,
				};
			}
			if (error === "expired_token") return { status: "failed", message: "Kimi device authorization expired" };
			if (error === "access_denied") return { status: "failed", message: "Kimi device authorization denied" };
			return { status: "failed", message: `Kimi device flow failed (${response.status})` };
		},
	});
}

export async function loginKimiCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const device = await requestDeviceAuthorization(callbacks.signal);
	callbacks.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForToken(device.deviceCode, device.intervalSeconds, device.expiresInSeconds, callbacks.signal);
}

export async function refreshKimiCodeToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	if (!refreshToken) throw new Error("Kimi credentials do not include a refresh token");
	const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			...(await getKimiCommonHeaders()),
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}).toString(),
		signal: requestSignal(signal),
	});
	const payload = (await readJsonObject(response)) as TokenResponse;
	if (!response.ok) throw new Error(`Kimi token refresh failed (${response.status})`);
	return parseTokenPayload(payload, refreshToken);
}

export const loginKimi = loginKimiCode;
export const refreshKimiToken = refreshKimiCodeToken;

export const kimiCodeOAuth: OAuthAuth = {
	name: "Kimi Code",
	async login(callbacks) {
		const credentials = await loginKimiCode({
			onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
			onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
			onPrompt: async (prompt) =>
				callbacks.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
			onSelect: async () => undefined,
			signal: callbacks.signal,
		});
		return { ...credentials, type: "oauth" };
	},
	refresh: async (credential) => ({ ...(await refreshKimiCodeToken(credential.refresh)), type: "oauth" }),
	toAuth: async (credential) => ({ apiKey: credential.access }),
};

export const kimiCodeOAuthProvider: OAuthProviderInterface = {
	id: "kimi-code",
	name: "Kimi Code",
	login: loginKimiCode,
	refreshToken: (credentials) => refreshKimiCodeToken(credentials.refresh),
	getApiKey: (credentials) => credentials.access,
};
