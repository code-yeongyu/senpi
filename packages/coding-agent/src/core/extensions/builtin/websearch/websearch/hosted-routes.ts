import type { SearchProvider } from "./types.ts";

export interface HostedRouteMapping {
	provider: SearchProvider;
	resource: string;
	routeLabel?: string;
	endpoint: (baseUrl: string) => string;
}

interface HostedModelInfo {
	provider: string;
	id: string;
	api?: string;
}

function trimTrailingSlashes(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function subscriptionResponsesUrl(baseUrl: string): string {
	const normalized = trimTrailingSlashes(baseUrl);
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function isGoogleSearchModel(id: string): boolean {
	return /^gemini-/.test(id) && !/(image|live|tts|embedding|computer-use)/.test(id);
}

/** Routes added automatically for the session's own provider. Google Search grounding is opt-in and never listed here. */
export function hostedRouteMapping(model: HostedModelInfo): HostedRouteMapping | null {
	if (model.api !== "openai-codex-responses" || model.id.includes("-spark")) return null;
	return {
		provider: "chatgpt-subscription",
		resource: "codex/responses",
		endpoint: subscriptionResponsesUrl,
		...(model.provider === "chatgpt-subscription" ? {} : { routeLabel: model.provider }),
	};
}

/** The Google API root a listed `google` entry searches through with the `google` login, or null for other models. */
export function googleLoginEndpoint(model: HostedModelInfo & { baseUrl: string }): string | null {
	if (model.provider !== "google" || model.api !== "google-generative-ai" || !isGoogleSearchModel(model.id)) {
		return null;
	}
	return trimTrailingSlashes(model.baseUrl);
}

/** Catalog headers plus the credential's headers; a null credential header removes the catalog one. */
export function credentialHeaders(
	modelHeaders: Record<string, string> | undefined,
	authHeaders: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	const headers = new Headers(modelHeaders);
	for (const [name, value] of Object.entries(authHeaders ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	const merged = Object.fromEntries(headers.entries());
	return Object.keys(merged).length > 0 ? merged : undefined;
}
