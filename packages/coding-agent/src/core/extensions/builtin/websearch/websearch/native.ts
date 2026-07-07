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
	const trimmed = baseUrl.replace(/\/+$/, "");
	const resourceSlash = `/${resource}`;
	if (trimmed.endsWith(resourceSlash)) return trimmed;
	if (/\/v\d+$/.test(trimmed)) return `${trimmed}${resourceSlash}`;
	return `${trimmed}/v1${resourceSlash}`;
}

export async function buildNativeEntry(
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

function nativeEntryKey(entry: SearchProviderEntry): string {
	return `${entry.provider}:${entry.baseUrl ?? ""}:${entry.model ?? ""}`;
}

function stableIdPart(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "model"
	);
}

function discoveredNativeEntryId(entry: SearchProviderEntry): string {
	return `native-${entry.provider}-${stableIdPart(entry.model ?? "model")}`;
}

export async function buildNativeEntries(
	model: NativeModelInfo | undefined,
	modelRegistry: NativeModelRegistry | undefined,
): Promise<SearchProviderEntry[]> {
	if (!modelRegistry) return [];

	const entries: SearchProviderEntry[] = [];
	const activeEntry = await buildNativeEntry(model, modelRegistry);
	if (activeEntry) entries.push(activeEntry);

	const seen = new Set(entries.map(nativeEntryKey));
	const availableModels = modelRegistry.getAvailable?.() ?? [];
	for (const availableModel of availableModels) {
		const entry = await buildNativeEntry(availableModel, modelRegistry, "native-discovered");
		if (!entry) continue;
		const key = nativeEntryKey(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ ...entry, id: discoveredNativeEntryId(entry) });
	}
	return entries;
}
