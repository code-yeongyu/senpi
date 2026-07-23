import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";

const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
const BROKER_URL = "https://zcode.z.ai/api/v1/oauth/token";
const ZAI_API_BASE_URL = "https://api.z.ai";
const ZAI_LOGIN_URL = `${ZAI_API_BASE_URL}/api/auth/z/login`;
const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const REDIRECT_URI = "zcode://oauth/callback";
const API_KEY_NAME = "zcode-api-key";
const REPROVISION_INTERVAL_MS = 55 * 60 * 1000;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function data(payload: unknown): JsonRecord {
	if (!isRecord(payload)) throw new Error("GLM ZCode response was not an object");
	return isRecord(payload.data) ? payload.data : payload;
}

async function request(url: string, options: RequestInit, signal: AbortSignal | undefined, label: string): Promise<unknown> {
	if (signal?.aborted) throw signal.reason ?? new Error("GLM ZCode login cancelled");
	const response = await fetch(url, { ...options, signal });
	if (!response.ok) throw new Error(`GLM ZCode ${label} request failed: ${response.status}`);
	return response.json();
}

async function post(url: string, body: JsonRecord, signal: AbortSignal | undefined, label: string, token?: string): Promise<unknown> {
	return request(url, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	}, signal, label);
}

async function get(url: string, signal: AbortSignal | undefined, label: string, token: string): Promise<unknown> {
	return request(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }, signal, label);
}

function callbackCode(value: string, state: string): string {
	const input = value.trim();
	if (!input) throw new Error("GLM ZCode authorization code is required");
	let callback: URL;
	try {
		callback = new URL(input);
	} catch {
		throw new Error("GLM ZCode requires the complete zcode:// callback URL");
	}
	if (callback.protocol !== "zcode:" || callback.hostname !== "oauth" || callback.pathname !== "/callback" || callback.port || callback.username || callback.password || callback.hash) {
		throw new Error("GLM ZCode callback URL is invalid");
	}
	const codes = callback.searchParams.getAll("code");
	const states = callback.searchParams.getAll("state");
	if (codes.length !== 1 || states.length !== 1 || !codes[0] || !states[0]) {
		throw new Error("GLM ZCode callback URL must contain exactly one non-empty code and state");
	}
	if (states[0] !== state) throw new Error("GLM ZCode callback state did not match");
	return codes[0];
}

async function provision(upstreamToken: string, signal: AbortSignal | undefined): Promise<OAuthCredentials> {
	const login = await post(ZAI_LOGIN_URL, { token: upstreamToken }, signal, "z/login");
	const businessToken = data(login).access_token;
	if (typeof businessToken !== "string" || !businessToken) throw new Error("GLM ZCode z/login response missing data.access_token");
	const customer = data(await get(`${ZAI_API_BASE_URL}/api/biz/customer/getCustomerInfo`, signal, "getCustomerInfo", businessToken));
	const organizations = Array.isArray(customer.organizations) ? customer.organizations.filter(isRecord) : [];
	const organization = organizations.find((entry) => entry.isDefault === true) ?? organizations[0];
	const projects = organization && Array.isArray(organization.projects) ? organization.projects.filter(isRecord) : [];
	const project = projects.find((entry) => entry.isDefault === true) ?? projects[0];
	const organizationId = organization?.organizationId;
	const projectId = project?.projectId;
	if (typeof organizationId !== "string" || typeof projectId !== "string") {
		throw new Error("GLM ZCode getCustomerInfo response missing default organization/project");
	}
	const keysUrl = `${ZAI_API_BASE_URL}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
	const listed = data(await get(keysUrl, signal, "api_keys.list", businessToken));
	const keys = Array.isArray(listed.data) ? listed.data.filter(isRecord) : [];
	let key = keys.find((entry) => entry.name === API_KEY_NAME);
	if (!key) key = data(await post(keysUrl, { name: API_KEY_NAME }, signal, "api_keys.create", businessToken));
	const keyId = typeof key.apiKey === "string" ? key.apiKey : key.id;
	if (typeof keyId !== "string" || !keyId) throw new Error("GLM ZCode api_keys response missing apiKey id");
	const copied = data(await get(`${keysUrl}/copy/${encodeURIComponent(keyId)}`, signal, "api_keys.copy", businessToken));
	if (typeof copied.secretKey !== "string" || !copied.secretKey) throw new Error("GLM ZCode api_keys copy response missing secretKey");
	return {
		access: `${keyId}.${copied.secretKey}`,
		refresh: upstreamToken,
		expires: Date.now() + REPROVISION_INTERVAL_MS,
		email: typeof customer.email === "string" ? customer.email.toLowerCase() : undefined,
		accountId: typeof customer.id === "string" || typeof customer.id === "number" ? String(customer.id) : undefined,
	};
}

export async function loginGlmZcode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const state = crypto.randomUUID();
	const params = new URLSearchParams({ redirect_uri: REDIRECT_URI, response_type: "code", client_id: CLIENT_ID, state });
	callbacks.onAuth({
		url: `${AUTHORIZE_URL}?${params}`,
		instructions: "Complete Z.AI login in your browser. This is an unofficial ZCode-based login without PKCE support; keep the final zcode:// redirect URL private, then paste it here.",
	});
	const input = callbacks.onManualCodeInput ? await callbacks.onManualCodeInput() : await callbacks.onPrompt({ message: "Paste the ZCode redirect URL" });
	const broker = data(await post(BROKER_URL, { provider: "zai", code: callbackCode(input, state), redirect_uri: REDIRECT_URI, state }, callbacks.signal, "broker"));
	const zai = isRecord(broker.zai) ? broker.zai : undefined;
	if (typeof zai?.access_token !== "string" || !zai.access_token) throw new Error("GLM ZCode broker response missing data.zai.access_token");
	callbacks.onProgress?.("Provisioning Z.AI API key...");
	return provision(zai.access_token, callbacks.signal);
}

export async function refreshGlmZcode(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.refresh) throw new Error("glm-zcode credentials require re-login (`/login glm-zcode`); no stored upstream Z.AI token");
	try {
		return await provision(credentials.refresh, undefined);
	} catch {
		throw new Error("glm-zcode credentials require re-login (`/login glm-zcode`); re-provisioning the Z.AI API key failed");
	}
}
