import type { Api, Model } from "@earendil-works/pi-ai";

export type OpenAiRemoteCompactionModel = Model<"openai-responses"> | Model<"openai-codex-responses">;

export type OpenAiRemoteCompactionIdentity =
	| { provider: "openai"; api: "openai-responses" }
	| { provider: "openai-codex"; api: "openai-codex-responses" };

type RemoteCompactionAuth = {
	apiKey?: string;
	headers?: Record<string, string>;
};

const OPENAI_CODEX_INSTALLATION_ID = crypto.randomUUID();

function isTrustedOpenAiCodexBaseUrl(baseUrl: string | undefined): boolean {
	try {
		const url = new URL(baseUrl || "https://chatgpt.com/backend-api");
		if (url.protocol === "https:" && url.hostname === "chatgpt.com") return true;
		return ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
	} catch {
		return false;
	}
}

export function parseOpenAiRemoteCompactionIdentity(
	provider: unknown,
	api: unknown,
): OpenAiRemoteCompactionIdentity | undefined {
	if (provider === "openai" && api === "openai-responses") {
		return { provider, api };
	}
	if (provider === "openai-codex" && api === "openai-codex-responses") {
		return { provider, api };
	}
	return undefined;
}

export function isOpenAiRemoteCompactionModel(model: Model<Api> | undefined): model is OpenAiRemoteCompactionModel {
	const identity = parseOpenAiRemoteCompactionIdentity(model?.provider, model?.api);
	if (!identity || !model) return false;
	return identity.api !== "openai-codex-responses" || isTrustedOpenAiCodexBaseUrl(model.baseUrl);
}

export function matchesOpenAiRemoteCompactionIdentity(
	model: OpenAiRemoteCompactionModel,
	identity: OpenAiRemoteCompactionIdentity,
): boolean {
	return model.provider === identity.provider && model.api === identity.api;
}

export function openAiRemoteCompactionIdentity(model: OpenAiRemoteCompactionModel): OpenAiRemoteCompactionIdentity {
	return model.api === "openai-codex-responses"
		? { provider: "openai-codex", api: "openai-codex-responses" }
		: { provider: "openai", api: "openai-responses" };
}

export function openAiRemoteCompactionEndpointPath(model: OpenAiRemoteCompactionModel): string {
	return model.api === "openai-codex-responses" ? "codex/responses/compact" : "responses/compact";
}

export function openAiRemoteCompactionEndpointUrl(model: OpenAiRemoteCompactionModel): string {
	const defaultBaseUrl =
		model.api === "openai-codex-responses" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1";
	const baseUrl = model.baseUrl || defaultBaseUrl;
	return new URL(
		openAiRemoteCompactionEndpointPath(model),
		baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
	).toString();
}

function extractCodexAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const base64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");
		const payload: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
		if (typeof payload !== "object" || payload === null) return undefined;
		const auth = Reflect.get(payload, "https://api.openai.com/auth");
		if (typeof auth !== "object" || auth === null) return undefined;
		const accountId = Reflect.get(auth, "chatgpt_account_id");
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

export function createOpenAiRemoteCompactionHeaders(
	model: OpenAiRemoteCompactionModel,
	auth: RemoteCompactionAuth,
	sessionId?: string,
): Headers | undefined {
	const headers = new Headers(auth.headers);
	headers.set("content-type", "application/json");
	if (model.api === "openai-codex-responses" && auth.apiKey) {
		headers.set("authorization", `Bearer ${auth.apiKey}`);
	} else if (!headers.has("authorization") && auth.apiKey) {
		headers.set("authorization", `Bearer ${auth.apiKey}`);
	}
	if (!headers.has("authorization")) return undefined;

	if (model.api === "openai-codex-responses") {
		const accountId = auth.apiKey ? extractCodexAccountId(auth.apiKey) : undefined;
		if (accountId && !headers.has("chatgpt-account-id")) {
			headers.set("chatgpt-account-id", accountId);
		}
		if (sessionId) {
			headers.set("session_id", sessionId);
			headers.set("session-id", sessionId);
			headers.set("thread-id", sessionId);
			headers.set("x-codex-installation-id", OPENAI_CODEX_INSTALLATION_ID);
			headers.set("x-codex-window-id", `${sessionId}:0`);
		}
		headers.set("originator", "senpi");
		headers.set("user-agent", "senpi");
		headers.set("OpenAI-Beta", "responses=experimental");
	}
	return headers;
}
