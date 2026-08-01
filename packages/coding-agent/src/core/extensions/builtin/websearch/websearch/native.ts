import { createHash } from "node:crypto";

import { isAllowedProviderBaseUrl } from "./provider-endpoints.ts";
import type { SearchProvider, SearchProviderEntry } from "./types.ts";

export interface NativeModelInfo {
	provider: string;
	id: string;
	baseUrl: string;
	api?: string;
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
	routeLabel?: string;
	endpointPath?: string;
}

interface NativeEntryOptions {
	id?: string;
	signal?: AbortSignal;
}

function nativeMapping(model: NativeModelInfo): NativeProviderMapping | null {
	const isOpenAiModel = /^gpt-(4o|4\.1|5)/.test(model.id) && !model.id.includes("codex");
	if (model.provider === "openai" && isOpenAiModel) {
		return { provider: "openai", resource: "responses" };
	}
	if (
		model.provider !== "openai" &&
		(model.api === "openai-responses" || model.api === "azure-openai-responses") &&
		isOpenAiModel
	) {
		return { provider: "openai", resource: "responses", routeLabel: model.provider };
	}

	if (model.provider === "anthropic" && /^claude-/.test(model.id)) {
		return { provider: "anthropic", resource: "messages" };
	}
	if (model.provider !== "anthropic" && model.api === "anthropic-messages" && /^claude-/.test(model.id)) {
		return { provider: "anthropic", resource: "messages", routeLabel: model.provider };
	}

	if (model.provider === "deepseek" && /^deepseek-v4-/.test(model.id)) {
		return {
			provider: "deepseek",
			resource: "messages",
			routeLabel: "deepseek",
			endpointPath: "/anthropic/v1/messages",
		};
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

function shouldDiscoverNativeRoute(activeModel: NativeModelInfo | undefined, availableModel: NativeModelInfo): boolean {
	const mapping = nativeMapping(availableModel);
	if (!mapping) return false;
	if (!activeModel) return true;
	return activeModel.provider === availableModel.provider;
}

function buildEndpointUrl(baseUrl: string, resource: string, endpointPath?: string): string {
	let configured: URL;
	try {
		configured = new URL(baseUrl);
	} catch {
		return baseUrl;
	}
	if (endpointPath) {
		configured.pathname = endpointPath;
		configured.hash = "";
		return configured.href;
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
	const baseUrl = buildEndpointUrl(model.baseUrl, mapping.resource, mapping.endpointPath);
	if (!isAllowedProviderBaseUrl(baseUrl)) return null;
	const routeUrl = new URL(baseUrl);
	routeUrl.hostname = routeUrl.hostname.replace(/\.$/, "");
	return `${mapping.provider}|${routeUrl.href}`;
}

function discoveredNativeEntryId(provider: SearchProvider, routeKey: string): string {
	const routeFingerprint = createHash("sha256").update(routeKey).digest("hex").slice(0, 16);
	return `native-${provider}-${routeFingerprint}`;
}

async function buildNativeEntryForModel(
	model: NativeModelInfo | undefined,
	modelRegistry: NativeModelRegistry | undefined,
	options: NativeEntryOptions = {},
): Promise<SearchProviderEntry | null> {
	if (!model || !modelRegistry) return null;
	const { id, signal } = options;

	const mapping = nativeMapping(model);
	if (!mapping) return null;
	const entryId = id ?? (mapping.routeLabel ? `${mapping.routeLabel}/native` : "native");
	const baseUrl = buildEndpointUrl(model.baseUrl, mapping.resource, mapping.endpointPath);
	if (!isAllowedProviderBaseUrl(baseUrl)) return null;

	signal?.throwIfAborted();
	const authPromise = modelRegistry.getApiKeyAndHeaders(model);
	let auth: NativeAuthResult;
	if (!signal) {
		auth = await authPromise;
	} else {
		signal.throwIfAborted();
		let removeAbortListener = (): void => {};
		const abortPromise = new Promise<never>((_resolve, reject) => {
			const onAbort = (): void => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		});
		try {
			auth = await Promise.race([authPromise, abortPromise]);
		} finally {
			removeAbortListener();
		}
	}
	if (!auth.ok || !auth.apiKey) return null;

	return {
		id: entryId,
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
	signal?: AbortSignal,
): Promise<SearchProviderEntry[]> {
	signal?.throwIfAborted();
	if (!modelRegistry) return [];

	const entries: SearchProviderEntry[] = [];
	const seenRoutes = new Set<string>();

	const activeRouteKey = model ? nativeRouteKey(model) : null;
	if (activeRouteKey) {
		seenRoutes.add(activeRouteKey);
		const activeEntry = await buildNativeEntryForModel(model, modelRegistry, { signal });
		if (activeEntry) entries.push(activeEntry);
	}

	if (!modelRegistry.getAvailable) return entries;

	for (const availableModel of modelRegistry.getAvailable()) {
		if (!shouldDiscoverNativeRoute(model, availableModel)) continue;
		const routeKey = nativeRouteKey(availableModel);
		if (!routeKey || seenRoutes.has(routeKey)) continue;
		seenRoutes.add(routeKey);
		const entry = await buildNativeEntryForModel(availableModel, modelRegistry, {
			id: "native-discovered",
			signal,
		});
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
	return buildNativeEntryForModel(model, modelRegistry, { id });
}
