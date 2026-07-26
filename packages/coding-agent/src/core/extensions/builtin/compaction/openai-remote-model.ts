import { createHash } from "node:crypto";
import { arch, platform, release } from "node:os";
import { type Api, extractOpenAiCodexAccountId, type Model } from "@earendil-works/pi-ai";

export type OpenAiRemoteCompactionModel = Model<"openai-responses"> | Model<"openai-codex-responses">;

export type OpenAiRemoteCompactionIdentity =
	| { provider: "openai"; api: "openai-responses" }
	| { provider: "openai-codex"; api: "openai-codex-responses" };

/** Non-secret remote state ownership persisted with a native checkpoint. */
export type OpenAiRemoteCompactionOrigin = {
	endpoint: string;
	trustDomain: string;
	authTenantFingerprint: string;
};

type RemoteCompactionAuth = {
	apiKey?: string;
	headers?: Record<string, string | null | undefined>;
};

/**
 * These headers carry request-local transport metadata only. All other final
 * headers, including routing and security headers, scope replay provenance.
 */
const VOLATILE_TRANSPORT_HEADER_NAMES = new Set([
	"content-length",
	"user-agent",
	"request-id",
	"x-client-request-id",
	"x-request-id",
]);

function defaultOpenAiRemoteCompactionBaseUrl(model: OpenAiRemoteCompactionModel): string {
	return model.api === "openai-codex-responses" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1";
}

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
	const baseUrl = model.baseUrl || defaultOpenAiRemoteCompactionBaseUrl(model);
	return new URL(
		openAiRemoteCompactionEndpointPath(model),
		baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
	).toString();
}

function normalizedOpenAiRemoteCompactionEndpoint(
	model: OpenAiRemoteCompactionModel,
): { endpoint: string; trustDomain: string } | undefined {
	try {
		const url = new URL(model.baseUrl || defaultOpenAiRemoteCompactionBaseUrl(model));
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		const endpoint = url.pathname === "/" ? url.origin : url.toString().replace(/\/$/, "");
		return { endpoint, trustDomain: url.origin };
	} catch {
		return undefined;
	}
}

export function openAiRemoteCompactionOrigin(
	model: OpenAiRemoteCompactionModel,
	headers: Headers | Record<string, string | null | undefined>,
): OpenAiRemoteCompactionOrigin | undefined {
	const endpoint = normalizedOpenAiRemoteCompactionEndpoint(model);
	if (!endpoint) return undefined;
	const finalHeaders = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
	const codexAccountId = finalHeaders.find(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1];
	if (model.api === "openai-codex-responses" && (typeof codexAccountId !== "string" || !codexAccountId)) {
		return undefined;
	}

	const tenantMaterial = finalHeaders
		.flatMap(([name, value]) => {
			const normalizedName = name.toLowerCase();
			if (typeof value !== "string" || VOLATILE_TRANSPORT_HEADER_NAMES.has(normalizedName)) return [];
			// Codex access JWTs rotate frequently. Its account header is stable and
			// remains in the fingerprint alongside every other final non-volatile
			// routing or security decision.
			if (model.api === "openai-codex-responses" && normalizedName === "authorization") return [];
			return [`${normalizedName}\u0000${value.trim()}`];
		})
		.sort();
	if (tenantMaterial.length === 0) return undefined;
	return {
		...endpoint,
		authTenantFingerprint: `sha256:${createHash("sha256").update(tenantMaterial.join("\n")).digest("hex")}`,
	};
}

function applyHeaders(
	headers: Headers,
	additionalHeaders: Record<string, string | null | undefined> | undefined,
): void {
	for (const [key, value] of Object.entries(additionalHeaders ?? {})) {
		if (value === null || value === undefined) headers.delete(key);
		else headers.set(key, value);
	}
}

export function createOpenAiRemoteCompactionHeaders(
	model: OpenAiRemoteCompactionModel,
	auth: RemoteCompactionAuth,
	sessionId?: string,
): Headers | undefined {
	const headers = new Headers(model.headers);
	applyHeaders(headers, auth.headers);
	headers.set("content-type", "application/json");
	if (model.api === "openai-codex-responses" && auth.apiKey) {
		// This matches the final Codex request contract: header hooks may add
		// routing headers, but cannot replace configured OAuth identity.
		headers.set("authorization", `Bearer ${auth.apiKey}`);
		const accountId = extractOpenAiCodexAccountId(auth.apiKey);
		if (accountId) headers.set("chatgpt-account-id", accountId);
		else headers.delete("chatgpt-account-id");
	} else if (!headers.has("authorization") && auth.apiKey) {
		headers.set("authorization", `Bearer ${auth.apiKey}`);
	}
	if (!headers.has("authorization")) return undefined;

	if (model.api === "openai-codex-responses") {
		headers.set("originator", "senpi");
		headers.set("user-agent", `senpi (${platform()} ${release()}; ${arch()})`);
		headers.set("OpenAI-Beta", "responses=experimental");
		headers.set("accept", "text/event-stream");
		if (sessionId) {
			headers.set("session-id", sessionId);
			headers.set("x-client-request-id", sessionId);
		}
	}
	return headers;
}
