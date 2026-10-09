import { credentialHeaders, googleLoginEndpoint } from "./hosted-routes.ts";
import { buildNativeEntry, type NativeModelInfo, type NativeModelRegistry } from "./native.ts";
import { isAllowedProviderBaseUrl } from "./provider-endpoints.ts";
import type { SearchProvider, SearchProviderEntry, WebsearchConfig } from "./types.ts";

const SESSION_LOGIN_PROVIDERS: ReadonlySet<SearchProvider> = new Set(["chatgpt-subscription", "google"]);

interface SessionLoginContext {
	model: NativeModelInfo | undefined;
	modelRegistry: NativeModelRegistry;
}

interface LoginCredential {
	apiKey: string;
	baseUrl: string;
	model: string;
	headers?: Record<string, string>;
}

function needsSessionLogin(entry: SearchProviderEntry): boolean {
	return SESSION_LOGIN_PROVIDERS.has(entry.provider) && !entry.apiKey;
}

function candidateModels(entry: SearchProviderEntry, context: SessionLoginContext): NativeModelInfo[] {
	const models = [...(context.model ? [context.model] : []), ...(context.modelRegistry.getAvailable?.() ?? [])].filter(
		(model) => model.provider === entry.provider,
	);
	const requested = entry.model ? models.filter((model) => model.id === entry.model) : [];
	return [...requested, ...models];
}

async function googleLogin(model: NativeModelInfo, registry: NativeModelRegistry): Promise<LoginCredential | null> {
	const root = googleLoginEndpoint(model);
	if (!root) return null;
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;
	const baseUrl = auth.baseUrl ? auth.baseUrl.replace(/\/+$/, "") : root;
	if (!isAllowedProviderBaseUrl(baseUrl)) return null;
	const headers = credentialHeaders(model.headers, auth.headers);
	return { apiKey: auth.apiKey, baseUrl, model: model.id, ...(headers ? { headers } : {}) };
}

async function subscriptionLogin(
	model: NativeModelInfo,
	registry: NativeModelRegistry,
	id: string,
): Promise<LoginCredential | null> {
	const entry = await buildNativeEntry(model, registry, id);
	if (!entry?.apiKey || !entry.baseUrl || entry.provider !== "chatgpt-subscription") return null;
	return {
		apiKey: entry.apiKey,
		baseUrl: entry.baseUrl,
		model: model.id,
		...(entry.headers ? { headers: entry.headers } : {}),
	};
}

async function resolveSessionLogin(
	entry: SearchProviderEntry,
	context: SessionLoginContext,
	signal: AbortSignal | undefined,
): Promise<SearchProviderEntry | null> {
	for (const candidate of candidateModels(entry, context)) {
		signal?.throwIfAborted();
		const login =
			entry.provider === "google"
				? await googleLogin(candidate, context.modelRegistry)
				: await subscriptionLogin(candidate, context.modelRegistry, entry.id ?? entry.provider);
		signal?.throwIfAborted();
		if (!login) continue;
		return { ...entry, ...login, model: entry.model ?? login.model };
	}
	return null;
}

/**
 * websearch.json entries for `chatgpt-subscription` or `google` without an apiKey search with the
 * matching senpi login, sent to that login's own endpoint. Entries with no such login are dropped.
 */
export async function resolveSessionLoginEntries(
	config: WebsearchConfig,
	context: SessionLoginContext | undefined,
	signal: AbortSignal | undefined,
): Promise<WebsearchConfig> {
	if (!config.providers.some(needsSessionLogin)) return config;
	const providers: SearchProviderEntry[] = [];
	for (const entry of config.providers) {
		if (!needsSessionLogin(entry)) {
			providers.push(entry);
			continue;
		}
		const resolved = context ? await resolveSessionLogin(entry, context, signal) : null;
		if (resolved) providers.push(resolved);
	}
	return { ...config, providers };
}
