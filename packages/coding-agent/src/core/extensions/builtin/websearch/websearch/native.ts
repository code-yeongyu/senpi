import { createHash } from "node:crypto";

import { isAllowedProviderBaseUrl } from "./provider-endpoints.ts";
import type { SearchProvider, SearchProviderEntry } from "./types.ts";

export interface NativeModelInfo {
	provider: string;
	id: string;
	baseUrl: string;
}

export type NativeAuthResult =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

export interface NativeModelRegistry {
	getApiKeyAndHeaders(model: NativeModelInfo): Promise<NativeAuthResult>;
	getAvailable?(): NativeModelInfo[];
}

interface NativeProviderMapping {
	provider: SearchProvider;
	resource: string;
}

function nativeMapping(model: NativeModelInfo): NativeProviderMapping | null {
	if (
		model.provider === "openai" &&
		(/^(gpt-5\.5(-fast)?|gpt-4\.1(-mini)?)$/.test(model.id) || /^gpt-4o(-mini)?(-\d{4}-\d{2}-\d{2})?$/.test(model.id))
	) {
		return { provider: "openai", resource: "responses" };
	}

	if (
		model.provider === "anthropic" &&
		(/^claude-(opus|sonnet)-4(-\d+)?$/.test(model.id) || /^claude-(opus|sonnet)-4-\d+-\d{8}$/.test(model.id))
	) {
		return { provider: "anthropic", resource: "messages" };
	}

	if (model.provider === "xai" && /^grok-/.test(model.id)) {
		return { provider: "xai", resource: "responses" };
	}

	if (model.provider === "perplexity" && /^sonar/.test(model.id)) {
		return { provider: "perplexity", resource: "chat/completions" };
	}

	if ((model.provider === "z-ai" || model.provider === "zai") && /^glm-/.test(model.id)) {
		return { provider: "z-ai", resource: "chat/completions" };
	}

	if (model.provider === "kimi-coding") {
		return { provider: "kimi", resource: "search" };
	}

	if (model.provider === "openrouter") {
		const slashIndex = model.id.indexOf("/");
		if (slashIndex <= 0) return null;
		const effectiveProvider = model.id.slice(0, slashIndex);
		const effectiveId = model.id.slice(slashIndex + 1);
		if (effectiveProvider === "openrouter") return null;
		return nativeMapping({ ...model, provider: effectiveProvider, id: effectiveId });
	}

	return null;
}

function buildEndpointUrl(baseUrl: string, resource: string): string {
	let configured: URL;
	try {
		configured = new URL(baseUrl);
	} catch {
		return baseUrl;
	}
	const trimmedPath = configured.pathname.replace(/\/+$/, "");
	const resourceSlash = `/${resource}`;
	if (trimmedPath.endsWith(resourceSlash)) {
		configured.pathname = trimmedPath;
	} else if (/\/v\d+$/.test(trimmedPath)) {
		configured.pathname = `${trimmedPath}${resourceSlash}`;
	} else {
		configured.pathname = `${trimmedPath}/v1${resourceSlash}`;
	}
	configured.hash = "";
	return configured.href;
}

function nativeRouteKey(model: NativeModelInfo): string | null {
	const mapping = nativeMapping(model);
	if (!mapping) return null;
	const baseUrl = buildEndpointUrl(model.baseUrl, mapping.resource);
	if (!isAllowedProviderBaseUrl(baseUrl)) return null;
	return `${mapping.provider}|${new URL(baseUrl).href}`;
}

function discoveredNativeEntryId(provider: SearchProvider, routeKey: string): string {
	const routeFingerprint = createHash("sha256").update(routeKey).digest("hex").slice(0, 16);
	return `native-${provider}-${routeFingerprint}`;
}

async function buildNativeEntryForModel(
	model: NativeModelInfo | undefined,
	modelRegistry: NativeModelRegistry | undefined,
	id = "native",
): Promise<SearchProviderEntry | null> {
	if (!model || !modelRegistry) return null;

	const mapping = nativeMapping(model);
	if (!mapping) return null;
	const baseUrl = buildEndpointUrl(model.baseUrl, mapping.resource);
	if (!isAllowedProviderBaseUrl(baseUrl)) return null;

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;

	return {
		id,
		provider: mapping.provider,
		apiKey: auth.apiKey,
		baseUrl,
		model: model.id,
		priority: -1,
	};
}
export async function buildNativeEntries(
	model: NativeModelInfo | undefined,
	modelRegistry: NativeModelRegistry | undefined,
): Promise<SearchProviderEntry[]> {
	if (!modelRegistry) return [];

	const entries: SearchProviderEntry[] = [];
	const seenRoutes = new Set<string>();

	const activeRouteKey = model ? nativeRouteKey(model) : null;
	if (activeRouteKey) {
		seenRoutes.add(activeRouteKey);
		const activeEntry = await buildNativeEntryForModel(model, modelRegistry);
		if (activeEntry) entries.push(activeEntry);
	}

	if (!modelRegistry.getAvailable) return entries;

	for (const availableModel of modelRegistry.getAvailable()) {
		const routeKey = nativeRouteKey(availableModel);
		if (!routeKey || seenRoutes.has(routeKey)) continue;
		seenRoutes.add(routeKey);
		const entry = await buildNativeEntryForModel(availableModel, modelRegistry, "native-discovered");
		if (!entry) continue;
		entries.push({ ...entry, id: discoveredNativeEntryId(entry.provider, routeKey) });
	}

	return entries;
}

export async function buildNativeEntry(
	model: NativeModelInfo | undefined,
	modelRegistry: NativeModelRegistry | undefined,
	id = "native",
): Promise<SearchProviderEntry | null> {
	return buildNativeEntryForModel(model, modelRegistry, id);
}
