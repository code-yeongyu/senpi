import type { OAuthAuth } from "../../auth/types.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const API_KEY_TTL_MS = 10 * 365 * 24 * 60 * 60_000;
const API_KEY_NAME = "zcode-api-key";

export const GLM_ZCODE_OAUTH_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
export const GLM_ZCODE_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const GLM_ZCODE_OAUTH_REDIRECT_URI = "zcode://oauth/callback";
export const GLM_ZCODE_OAUTH_BROKER_TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
export const GLM_ZCODE_ZAI_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
export const GLM_ZCODE_USERINFO_URL = "https://chat.z.ai/api/oauth/userinfo";
export const GLM_ZCODE_ZAI_API_BASE = "https://api.z.ai";
export const GLM_ZCODE_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";

type FetchImpl = typeof globalThis.fetch;
type AuthorizationInput = { code?: string; state?: string };
type Identity = { email?: string; accountId?: string };

function envOr(name: string, fallback: string): string {
	if (typeof process === "undefined") return fallback;
	const value = process.env[name]?.trim();
	return value || fallback;
}

function resolveAuthorizeUrl(): string {
	return envOr("ZCODE_OAUTH_AUTHORIZE_URL", GLM_ZCODE_OAUTH_AUTHORIZE_URL);
}

function resolveClientId(): string {
	return envOr("ZCODE_OAUTH_CLIENT_ID", GLM_ZCODE_OAUTH_CLIENT_ID);
}

function resolveRedirectUri(): string {
	return envOr("ZCODE_OAUTH_REDIRECT_URI", GLM_ZCODE_OAUTH_REDIRECT_URI);
}

function resolveBrokerTokenUrl(): string {
	return envOr("ZCODE_OAUTH_BROKER_TOKEN_URL", GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
}

function resolveZaiLoginUrl(): string {
	return envOr("ZCODE_OAUTH_ZAI_LOGIN_URL", GLM_ZCODE_ZAI_LOGIN_URL);
}

function resolveUserinfoUrl(): string {
	return envOr("ZCODE_OAUTH_USERINFO_URL", GLM_ZCODE_USERINFO_URL);
}

function resolveZaiApiBase(): string {
	return envOr("ZCODE_OAUTH_ZAI_API_BASE", GLM_ZCODE_ZAI_API_BASE).replace(/\/+$/, "");
}

export function isGlmZcodeOAuthConfigured(): boolean {
	return resolveClientId().length > 0;
}

function validateHttpsEndpoint(rawUrl: string, label: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`GLM ZCode ${label} endpoint is invalid`);
	}
	if (url.protocol !== "https:") throw new Error(`GLM ZCode ${label} endpoint must use HTTPS`);
	const host = url.hostname.toLowerCase();
	if (host !== "z.ai" && !host.endsWith(".z.ai"))
		throw new Error(`GLM ZCode ${label} endpoint must be on a z.ai host`);
	return url.toString().replace(/\/+$/, "");
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("GLM ZCode OAuth login was cancelled", "AbortError");
	}
}

async function request(
	fetchImpl: FetchImpl,
	url: string,
	init: RequestInit,
	label: string,
	signal?: AbortSignal,
): Promise<Response> {
	try {
		const response = await fetchImpl(url, { ...init, signal: requestSignal(signal) });
		if (!response.ok) throw new Error(`GLM ZCode ${label} request failed (${response.status})`);
		return response;
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		if (error instanceof Error && /^GLM ZCode .* request failed \(\d{3}\)$/.test(error.message)) throw error;
		throw new Error(`GLM ZCode ${label} request failed`);
	}
}

async function postJson(
	fetchImpl: FetchImpl,
	url: string,
	body: Record<string, unknown>,
	label: string,
	signal?: AbortSignal,
	bearer?: string,
): Promise<unknown> {
	const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
	if (bearer) headers.Authorization = `Bearer ${bearer}`;
	const response = await request(
		fetchImpl,
		url,
		{ method: "POST", headers, body: JSON.stringify(body) },
		label,
		signal,
	);
	return response.json();
}

async function getJson(
	fetchImpl: FetchImpl,
	url: string,
	bearer: string,
	label: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await request(
		fetchImpl,
		url,
		{ headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` } },
		label,
		signal,
	);
	return response.json();
}

export function parseGlmZcodeAuthorizationInput(input: string): AuthorizationInput {
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

function decodeJwtIdentity(token: string): Identity {
	const parts = token.split(".");
	const payload = parts[1];
	if (parts.length !== 3 || !payload) return {};
	try {
		const padded = payload
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const decoded = JSON.parse(atob(padded)) as Record<string, unknown>;
		return {
			accountId: typeof decoded.sub === "string" && decoded.sub ? decoded.sub : undefined,
			email: typeof decoded.email === "string" && decoded.email ? decoded.email.toLowerCase() : undefined,
		};
	} catch {
		return {};
	}
}

function parseBrokerResponse(payload: unknown): { upstreamAccess: string; zcodeToken: string } {
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
	const zai = data && isRecord(data.zai) ? data.zai : undefined;
	const zcodeToken = data && typeof data.token === "string" ? data.token : undefined;
	const upstreamAccess = zai && typeof zai.access_token === "string" ? zai.access_token : undefined;
	if (!zcodeToken || !upstreamAccess) {
		throw new Error("GLM ZCode broker response missing required tokens");
	}
	return { upstreamAccess, zcodeToken };
}

async function resolveBusinessToken(
	fetchImpl: FetchImpl,
	upstreamAccess: string,
	signal?: AbortSignal,
): Promise<string> {
	const url = validateHttpsEndpoint(resolveZaiLoginUrl(), "z/login");
	const payload = await postJson(fetchImpl, url, { token: upstreamAccess }, "z/login", signal);
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
	if (!data || typeof data.access_token !== "string" || !data.access_token) {
		throw new Error("GLM ZCode z/login response missing access token");
	}
	return data.access_token;
}

function pickOrgProject(payload: unknown): {
	organizationId: string;
	projectId: string;
	identity: Identity;
} {
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
	const root = isRecord(data) ? data : {};
	const organizations = Array.isArray(root.organizations) ? root.organizations : [];
	const organization = (organizations.find((value) => isRecord(value) && value.isDefault === true) ??
		organizations[0]) as Record<string, unknown> | undefined;
	const projects = organization && Array.isArray(organization.projects) ? organization.projects : [];
	const project = (projects.find((value) => isRecord(value) && value.isDefault === true) ?? projects[0]) as
		| Record<string, unknown>
		| undefined;
	const organizationId =
		organization && typeof organization.organizationId === "string"
			? organization.organizationId
			: organization && typeof organization.id === "string"
				? organization.id
				: undefined;
	const projectId =
		project && typeof project.projectId === "string"
			? project.projectId
			: project && typeof project.id === "string"
				? project.id
				: undefined;
	if (!organizationId || !projectId) {
		throw new Error("GLM ZCode customer response missing default organization or project");
	}
	return {
		organizationId,
		projectId,
		identity: {
			email: typeof root.email === "string" && root.email ? root.email.toLowerCase() : undefined,
			accountId: typeof root.id === "string" ? root.id : typeof root.id === "number" ? String(root.id) : undefined,
		},
	};
}

async function provisionApiKey(
	fetchImpl: FetchImpl,
	businessToken: string,
	signal?: AbortSignal,
): Promise<{ apiKey: string; identity: Identity }> {
	const apiBase = validateHttpsEndpoint(resolveZaiApiBase(), "business API");
	const customer = await getJson(
		fetchImpl,
		`${apiBase}/api/biz/customer/getCustomerInfo`,
		businessToken,
		"getCustomerInfo",
		signal,
	);
	const { organizationId, projectId, identity } = pickOrgProject(customer);
	const keysUrl = `${apiBase}/api/biz/v1/organization/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/api_keys`;
	const listPayload = await getJson(fetchImpl, keysUrl, businessToken, "api_keys.list", signal);
	const listData = isRecord(listPayload) && Array.isArray(listPayload.data) ? listPayload.data : [];
	let entry = listData.find((value) => isRecord(value) && value.name === API_KEY_NAME) as
		| Record<string, unknown>
		| undefined;
	if (!entry) {
		const created = await postJson(
			fetchImpl,
			keysUrl,
			{ name: API_KEY_NAME },
			"api_keys.create",
			signal,
			businessToken,
		);
		entry = isRecord(created) && isRecord(created.data) ? created.data : isRecord(created) ? created : undefined;
	}
	const apiKeyId =
		entry && typeof entry.apiKey === "string"
			? entry.apiKey.trim()
			: entry && typeof entry.id === "string"
				? entry.id.trim()
				: "";
	if (!apiKeyId) throw new Error("GLM ZCode API-key response missing key ID");
	const copied = await getJson(
		fetchImpl,
		`${keysUrl}/copy/${encodeURIComponent(apiKeyId)}`,
		businessToken,
		"api_keys.copy",
		signal,
	);
	const copyData = isRecord(copied) && isRecord(copied.data) ? copied.data : copied;
	const secretKey = isRecord(copyData) && typeof copyData.secretKey === "string" ? copyData.secretKey.trim() : "";
	if (!secretKey) throw new Error("GLM ZCode API-key copy response missing secret");
	return { apiKey: `${apiKeyId}.${secretKey}`, identity };
}

async function resolveIdentity(
	fetchImpl: FetchImpl,
	upstreamAccess: string,
	fallback: Identity,
	jwtCandidates: readonly string[],
	signal?: AbortSignal,
): Promise<Identity> {
	if (fallback.email || fallback.accountId) return fallback;
	try {
		const userinfo = await getJson(
			fetchImpl,
			validateHttpsEndpoint(resolveUserinfoUrl(), "userinfo"),
			upstreamAccess,
			"userinfo",
			signal,
		);
		const data = isRecord(userinfo) && isRecord(userinfo.data) ? userinfo.data : userinfo;
		if (isRecord(data)) {
			const identity = {
				email: typeof data.email === "string" && data.email ? data.email.toLowerCase() : undefined,
				accountId:
					typeof data.id === "string" && data.id
						? data.id
						: typeof data.sub === "string" && data.sub
							? data.sub
							: undefined,
			};
			if (identity.email || identity.accountId) return identity;
		}
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		// Identity is optional; continue with JWT claims.
	}
	for (const token of jwtCandidates) {
		const identity = decodeJwtIdentity(token);
		if (identity.email || identity.accountId) return identity;
	}
	return {};
}

async function provisionFromUpstream(
	fetchImpl: FetchImpl,
	upstreamAccess: string,
	zcodeIdentityToken: string | undefined,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const businessToken = await resolveBusinessToken(fetchImpl, upstreamAccess, signal);
	const { apiKey, identity: provisionedIdentity } = await provisionApiKey(fetchImpl, businessToken, signal);
	const identity = await resolveIdentity(
		fetchImpl,
		upstreamAccess,
		provisionedIdentity,
		[zcodeIdentityToken ?? "", businessToken].filter(Boolean),
		signal,
	);
	return {
		access: apiKey,
		refresh: upstreamAccess,
		expires: Date.now() + API_KEY_TTL_MS,
		...(identity.email ? { email: identity.email } : {}),
		...(identity.accountId ? { accountId: identity.accountId } : {}),
	};
}

export interface GlmZcodeOAuthOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

export async function exchangeGlmZcodeAuthorizationCode(
	code: string,
	state: string,
	redirectUri = resolveRedirectUri(),
	options: GlmZcodeOAuthOptions = {},
): Promise<OAuthCredentials> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const brokerUrl = validateHttpsEndpoint(resolveBrokerTokenUrl(), "broker");
	const payload = await postJson(
		fetchImpl,
		brokerUrl,
		{ provider: "zai", code, redirect_uri: redirectUri, state },
		"broker",
		options.signal,
	);
	const { upstreamAccess, zcodeToken } = parseBrokerResponse(payload);
	return provisionFromUpstream(fetchImpl, upstreamAccess, zcodeToken, options.signal);
}

function abortPromise(signal?: AbortSignal): Promise<never> | undefined {
	if (!signal) return undefined;
	return new Promise((_, reject) => {
		const rejectAbort = () =>
			reject(signal.reason ?? new DOMException("GLM ZCode OAuth login was cancelled", "AbortError"));
		if (signal.aborted) rejectAbort();
		else signal.addEventListener("abort", rejectAbort, { once: true });
	});
}

export async function loginGlmZcode(
	callbacks: OAuthLoginCallbacks,
	options: Omit<GlmZcodeOAuthOptions, "signal"> = {},
): Promise<OAuthCredentials> {
	throwIfAborted(callbacks.signal);
	const readManualCode =
		callbacks.onManualCodeInput ??
		(() =>
			callbacks.onPrompt({
				message: "Paste the zcode:// callback URL or authorization code",
				placeholder: GLM_ZCODE_OAUTH_REDIRECT_URI,
			}));
	const state = crypto.randomUUID();
	const redirectUri = resolveRedirectUri();
	const authorizeUrl = validateHttpsEndpoint(resolveAuthorizeUrl(), "authorize");
	const params = new URLSearchParams({
		redirect_uri: redirectUri,
		response_type: "code",
		client_id: resolveClientId(),
		state,
	});
	callbacks.onAuth({
		url: `${authorizeUrl}?${params}`,
		instructions:
			"Complete Z.AI login in your browser. This is an UNOFFICIAL, opt-in ZCode login. Paste the final zcode:// redirect URL or authorization code.",
	});
	const manualCode = readManualCode().then((input) => {
		const parsed = parseGlmZcodeAuthorizationInput(input);
		if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
		if (!parsed.code) throw new Error("Missing authorization code");
		return parsed.code;
	});
	const candidates: Promise<string>[] = [manualCode];
	const aborted = abortPromise(callbacks.signal);
	if (aborted) candidates.push(aborted);
	const code = await Promise.race(candidates);
	return exchangeGlmZcodeAuthorizationCode(code, state, redirectUri, {
		fetch: options.fetch,
		signal: callbacks.signal,
	});
}

function safeRefreshDetail(error: unknown): string {
	const status = String(error).match(/\((\d{3})\)/)?.[1];
	return status ? `request failed (${status})` : "request failed";
}

export async function refreshGlmZcodeToken(
	credentials: OAuthCredentials,
	options: GlmZcodeOAuthOptions | AbortSignal = {},
): Promise<OAuthCredentials> {
	if (!credentials.refresh) throw new Error("GLM ZCode credentials require re-login; no upstream token is stored");
	const resolved = options instanceof AbortSignal ? { signal: options } : options;
	try {
		return await provisionFromUpstream(
			resolved.fetch ?? globalThis.fetch,
			credentials.refresh,
			undefined,
			resolved.signal,
		);
	} catch (error) {
		if (resolved.signal?.aborted) throw resolved.signal.reason ?? error;
		throw new Error(`GLM ZCode credentials require re-login; API-key provisioning ${safeRefreshDetail(error)}`);
	}
}

export const glmZcodeOAuth: OAuthAuth = {
	name: "GLM ZCode OAuth (unofficial, opt-in)",
	async login(callbacks) {
		const manualAbort = new AbortController();
		try {
			const credentials = await loginGlmZcode({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: () => {},
				onPrompt: async (prompt) =>
					callbacks.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
				onManualCodeInput: () =>
					callbacks.prompt({
						type: "manual_code",
						message: "Paste the zcode:// callback URL or authorization code:",
						placeholder: GLM_ZCODE_OAUTH_REDIRECT_URI,
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
	refresh: async (credential) => ({ ...(await refreshGlmZcodeToken(credential)), type: "oauth" }),
	toAuth: async (credential) => ({
		apiKey: credential.access,
		headers: { Authorization: `Bearer ${credential.access}` },
	}),
};

export const glmZcodeOAuthProvider: OAuthProviderInterface = {
	id: "glm-zcode",
	name: "GLM ZCode OAuth (unofficial, opt-in)",
	// Senpi uses this flag to expose the manual redirect input alongside the browser URL.
	usesCallbackServer: true,
	login: loginGlmZcode,
	refreshToken: refreshGlmZcodeToken,
	getApiKey: (credentials) => credentials.access,
};
