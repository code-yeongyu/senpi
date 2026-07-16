/**
 * Radius gateway OAuth flow and model catalog loading.
 *
 * Radius is a pi-messages gateway. OAuth endpoints are discovered from the
 * gateway (`/v1/oauth`); the model catalog comes from `/v1/config` and is
 * cached on the stored credential (`gatewayConfig`) so models are available
 * at startup and refreshed whenever the token refreshes.
 *
 * NOTE: This module uses node:http for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds
let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:http").then((m) => {
		_http = m;
	});
}

import type { Api, Model, ThinkingLevelMap } from "../../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const DEFAULT_RADIUS_GATEWAY = "https://radius.pi.dev";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 1456;
const CALLBACK_PATH = "/oauth/callback";
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const LOGIN_METHOD_BROWSER = "browser";
const LOGIN_METHOD_DEVICE_CODE = "device-code";

/** Model metadata served by the gateway config endpoint. */
export type RadiusGatewayModel = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: Model<Api>["cost"];
	contextWindow: number;
	maxTokens: number;
};

export type RadiusGatewayConfig = {
	baseUrl: string;
	models: RadiusGatewayModel[];
};

export type RadiusOAuthCredentials = OAuthCredentials & {
	gatewayConfig?: RadiusGatewayConfig;
};

type RadiusOAuthConfig = {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	deviceAuthorizationEndpoint: string;
	deviceAuthorizationEventsEndpoint: string;
	verificationEndpoint: string;
	clientId: string;
	scope: string;
	deviceCodeGrantType: string;
};

type DeviceAuthorizationResponse = {
	device_code: string;
	user_code: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRadiusGatewayUrl(value: string): string {
	const withScheme = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
	return withScheme.replace(/\/+$/u, "");
}

// The gateway is a trusted first-party service. The shape checks below only
// guard against version skew and stale credential caches: malformed entries
// are dropped rather than failing the whole catalog, and nested fields (e.g.
// `input` members, `cost` rates) are intentionally not validated in depth.
// Do not turn this into strict validation.
function isRadiusGatewayModel(value: unknown): value is RadiusGatewayModel {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.reasoning === "boolean" &&
		Array.isArray(value.input) &&
		isRecord(value.cost) &&
		typeof value.contextWindow === "number" &&
		typeof value.maxTokens === "number"
	);
}

function sanitizeRadiusGatewayConfig(config: unknown): RadiusGatewayConfig | undefined {
	if (!isRecord(config)) {
		return undefined;
	}
	const baseUrl = config.baseUrl;
	const models = config.models;
	if (typeof baseUrl !== "string" || !Array.isArray(models)) {
		return undefined;
	}

	return {
		baseUrl,
		models: models.filter(isRadiusGatewayModel).map((model) => ({ ...model })),
	};
}

function getRadiusCredentialConfig(credentials: OAuthCredentials | undefined): RadiusGatewayConfig | undefined {
	return sanitizeRadiusGatewayConfig((credentials as RadiusOAuthCredentials | undefined)?.gatewayConfig);
}

function truncateHttpBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

async function loadRadiusGatewayConfig(gateway: string, apiKey?: string): Promise<RadiusGatewayConfig> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const response = await fetch(new URL("/v1/config", gateway), { headers });
	if (!response.ok) {
		throw new Error(
			`Could not load Radius config from ${gateway}: ${response.status}: ${truncateHttpBody(await response.text())}`,
		);
	}

	const config = sanitizeRadiusGatewayConfig(await response.json());
	if (!config) {
		throw new Error(`Invalid Radius config from ${gateway}`);
	}
	return config;
}

async function loadRadiusOAuthConfig(gateway: string): Promise<RadiusOAuthConfig> {
	const response = await fetch(new URL("/v1/oauth", gateway), {
		headers: { accept: "application/json" },
	});

	if (!response.ok) {
		throw new Error(
			`Could not load Radius OAuth config from ${gateway}: ${response.status} ${await response.text()}`,
		);
	}

	return (await response.json()) as RadiusOAuthConfig;
}

class OAuthResponseError extends Error {
	readonly status: number;
	readonly oauthError?: string;

	constructor(status: number, oauthError: string | undefined, description: string | undefined, message: string) {
		const detail = oauthError
			? description
				? `${oauthError}: ${description}`
				: oauthError
			: description || String(status);
		super(`${message}: ${detail}`);
		this.status = status;
		this.oauthError = oauthError;
	}
}

async function readOAuthResponseError(response: Response, message: string): Promise<OAuthResponseError> {
	const text = await response.text().catch(() => "");
	let oauthError: string | undefined;
	let description: string | undefined;

	if (text) {
		try {
			const data = JSON.parse(text) as { error?: unknown; error_description?: unknown };
			oauthError = typeof data.error === "string" ? data.error : undefined;
			description = typeof data.error_description === "string" ? data.error_description : undefined;
		} catch {
			description = text;
		}
	}

	return new OAuthResponseError(response.status, oauthError, description, message);
}

async function requestOAuthToken(
	oauth: RadiusOAuthConfig,
	body: URLSearchParams,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	let response: Response;
	try {
		response = await fetch(oauth.tokenEndpoint, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body,
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	if (!response.ok) {
		throw await readOAuthResponseError(response, "Radius OAuth token request failed");
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		scope?: string;
	};

	return {
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS,
		scope: data.scope,
	};
}

type OAuthCallbackServer = {
	waitForCode(): Promise<string | null>;
	close(): void;
};

function startOAuthCallbackServer(
	expectedState: string,
	signal: AbortSignal | undefined,
): Promise<OAuthCallbackServer> {
	if (!_http) {
		throw new Error("Radius OAuth is only available in Node.js environments");
	}

	let settle: (code: string | null) => void = () => {};
	let settled = false;
	const wait = new Promise<string | null>((resolve) => {
		settle = resolve;
	});
	const finish = (code: string | null) => {
		if (settled) {
			return;
		}
		settled = true;
		signal?.removeEventListener("abort", onAbort);
		settle(code);
	};
	const onAbort = () => finish(null);
	signal?.addEventListener("abort", onAbort, { once: true });

	const sendPage = (response: import("node:http").ServerResponse, status: number, html: string) => {
		response.statusCode = status;
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(html);
	};

	const server = _http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", REDIRECT_URI);
		if (url.pathname !== CALLBACK_PATH) {
			sendPage(response, 404, oauthErrorHtml("Callback route not found."));
			return;
		}
		if (url.searchParams.get("state") !== expectedState) {
			sendPage(response, 400, oauthErrorHtml("OAuth state mismatch."));
			return;
		}

		const error = url.searchParams.get("error");
		if (error) {
			sendPage(response, 400, oauthErrorHtml(url.searchParams.get("error_description") ?? error));
			finish(null);
			return;
		}

		const code = url.searchParams.get("code");
		if (!code) {
			sendPage(response, 400, oauthErrorHtml("Missing authorization code."));
			return;
		}

		sendPage(response, 200, oauthSuccessHtml("Signed in to Radius. You may now close this page."));
		finish(code);
	});

	return new Promise((resolve) => {
		server
			.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
				resolve({
					waitForCode: () => wait,
					close: () => {
						finish(null);
						server.close();
					},
				});
			})
			.once("error", () => {
				finish(null);
				resolve({ waitForCode: async () => null, close: () => {} });
			});
	});
}

async function loginWithBrowser(oauth: RadiusOAuthConfig, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const authorizeUrl = new URL(oauth.authorizationEndpoint);
	authorizeUrl.search = new URLSearchParams({
		response_type: "code",
		client_id: oauth.clientId,
		redirect_uri: REDIRECT_URI,
		scope: oauth.scope,
		code_challenge: challenge,
		code_challenge_method: "S256",
		handoff: "url",
		state,
	}).toString();

	const callbackServer = await startOAuthCallbackServer(state, callbacks.signal);
	callbacks.onProgress?.(`Listening for OAuth callback on ${REDIRECT_URI}`);
	callbacks.onAuth({
		url: authorizeUrl.toString(),
		instructions: "Continue in your browser.",
	});

	try {
		const code = await callbackServer.waitForCode();
		if (!code) {
			if (callbacks.signal?.aborted) {
				throw new Error("Login cancelled");
			}
			throw new Error("OAuth callback did not complete.");
		}
		return await requestOAuthToken(
			oauth,
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: oauth.clientId,
				redirect_uri: REDIRECT_URI,
				code,
				code_verifier: verifier,
			}),
			callbacks.signal,
		);
	} finally {
		callbackServer.close();
	}
}

async function requestDeviceAuthorization(
	oauth: RadiusOAuthConfig,
	signal: AbortSignal | undefined,
): Promise<DeviceAuthorizationResponse> {
	let response: Response;
	try {
		response = await fetch(oauth.deviceAuthorizationEndpoint, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: oauth.clientId, scope: oauth.scope }),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	if (!response.ok) {
		throw await readOAuthResponseError(response, "Radius OAuth device authorization failed");
	}

	const data = (await response.json()) as Partial<DeviceAuthorizationResponse>;
	if (!data.device_code || !data.user_code || !data.expires_in) {
		throw new Error("Radius OAuth device authorization response is missing required fields");
	}

	return {
		device_code: data.device_code,
		user_code: data.user_code,
		verification_uri: data.verification_uri,
		verification_uri_complete: data.verification_uri_complete,
		expires_in: data.expires_in,
		interval: data.interval,
	};
}

async function loginWithDeviceCode(
	oauth: RadiusOAuthConfig,
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const device = await requestDeviceAuthorization(oauth, callbacks.signal);
	callbacks.onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri || oauth.verificationEndpoint,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});

	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		signal: callbacks.signal,
		poll: async () => {
			try {
				const credentials = await requestOAuthToken(
					oauth,
					new URLSearchParams({
						grant_type: oauth.deviceCodeGrantType,
						client_id: oauth.clientId,
						device_code: device.device_code,
					}),
					callbacks.signal,
				);
				return { status: "complete", value: credentials };
			} catch (error) {
				if (!(error instanceof OAuthResponseError)) {
					throw error;
				}
				switch (error.oauthError) {
					case "authorization_pending":
						return { status: "pending" };
					case "slow_down":
						return { status: "slow_down" };
					case "expired_token":
						return { status: "failed", message: "Device authorization expired." };
					case "access_denied":
						return { status: "failed", message: "Device authorization was denied." };
					default:
						throw error;
				}
			}
		},
	});
}

async function attachGatewayConfig(
	gateway: string,
	credentials: OAuthCredentials,
	previous?: OAuthCredentials,
): Promise<RadiusOAuthCredentials> {
	try {
		const config = await loadRadiusGatewayConfig(gateway, credentials.access);
		return { ...credentials, gatewayConfig: config };
	} catch (error) {
		// Keep the previous catalog so models do not vanish on transient
		// config failures; the next token refresh retries.
		const previousConfig = getRadiusCredentialConfig(previous);
		if (previousConfig) {
			return { ...credentials, gatewayConfig: previousConfig };
		}
		// No catalog to retain (e.g. initial login): fail loudly instead of
		// completing a sign-in that would register no models.
		throw error;
	}
}

export interface RadiusOAuthProviderOptions {
	id: string;
	name: string;
	gateway: string;
}

export function createRadiusOAuthProvider(options: RadiusOAuthProviderOptions): OAuthProviderInterface {
	const gateway = normalizeRadiusGatewayUrl(options.gateway);

	return {
		id: options.id,
		name: options.name,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const oauth = await loadRadiusOAuthConfig(gateway);
			const loginMethod = await callbacks.onSelect({
				message: `Sign in to ${options.name}:`,
				options: [
					{ id: LOGIN_METHOD_BROWSER, label: "Sign in with browser (recommended)" },
					{
						id: LOGIN_METHOD_DEVICE_CODE,
						label: "Sign in with device code (when signing in from another device)",
					},
				],
			});
			if (!loginMethod) {
				throw new Error("Login cancelled");
			}

			let credentials: OAuthCredentials;
			if (loginMethod === LOGIN_METHOD_DEVICE_CODE) {
				credentials = await loginWithDeviceCode(oauth, callbacks);
			} else if (loginMethod === LOGIN_METHOD_BROWSER) {
				credentials = await loginWithBrowser(oauth, callbacks);
			} else {
				throw new Error(`Unknown ${options.name} sign-in method: ${loginMethod}`);
			}

			return attachGatewayConfig(gateway, credentials);
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			const oauth = await loadRadiusOAuthConfig(gateway);
			const refreshed = await requestOAuthToken(
				oauth,
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: oauth.clientId,
					refresh_token: credentials.refresh,
				}),
			);
			return attachGatewayConfig(gateway, refreshed, credentials);
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},

		modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
			const config = getRadiusCredentialConfig(credentials);
			if (!config) {
				return models;
			}

			// Keep models already registered for this provider (e.g. models.json
			// custom entries) and add catalog models that are not present.
			const existingIds = new Set(models.filter((model) => model.provider === options.id).map((model) => model.id));
			const added = config.models
				.filter((model) => !existingIds.has(model.id))
				.map(
					(model) =>
						({
							...model,
							api: "pi-messages",
							provider: options.id,
							baseUrl: config.baseUrl,
						}) as Model<Api>,
				);

			return [...models, ...added];
		},
	};
}
