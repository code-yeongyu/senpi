import { parseHtmlDocument } from "./html-document.lazy.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { braveProvider } from "./providers/brave.ts";
import { chatgptSubscriptionProvider } from "./providers/chatgpt-subscription.ts";
import { deepseekProvider } from "./providers/deepseek.ts";
import { duckDuckGoHtmlProvider } from "./providers/duckduckgo-html.ts";
import { ecosiaProvider } from "./providers/ecosia.ts";
import { exaProvider } from "./providers/exa.ts";
import { exaMcpProvider } from "./providers/exa-mcp.ts";
import { googleProvider } from "./providers/google.ts";
import { googleCseProvider } from "./providers/google-cse.ts";
import { googleHtmlProvider } from "./providers/google-html.ts";
import { kagiProvider } from "./providers/kagi.ts";
import { keenableProvider } from "./providers/keenable.ts";
import { kimiProvider } from "./providers/kimi.ts";
import { mojeekProvider } from "./providers/mojeek.ts";
import { openAiResponsesProvider } from "./providers/openai-responses.ts";
import { perplexityProvider } from "./providers/perplexity.ts";
import { searxngProvider } from "./providers/searxng.ts";
import { serpdiveProvider } from "./providers/serpdive.ts";
import { serperProvider } from "./providers/serper.ts";
import type { BuildContext, FetchedPage, PageFetcher, ProviderModule, ResponseFormat } from "./providers/shared.ts";
import { parseObjectPayload, resolveDomainFilters } from "./providers/shared.ts";
import { startpageProvider } from "./providers/startpage.ts";
import { tavilyProvider } from "./providers/tavily.ts";
import { xaiProvider } from "./providers/xai.ts";
import { zAiProvider } from "./providers/z-ai.ts";
import type {
	BuiltSearchRequest,
	JsonObject,
	SearchProvider,
	SearchProviderConfig,
	SearchRequest,
	SearchResultItem,
} from "./types.ts";

const PROVIDER_MODULES: Record<SearchProvider, ProviderModule> = {
	exa: exaProvider,
	tavily: tavilyProvider,
	serpdive: serpdiveProvider,
	brave: braveProvider,
	"duckduckgo-html": duckDuckGoHtmlProvider,
	deepseek: deepseekProvider,
	serper: serperProvider,
	"google-cse": googleCseProvider,
	"z-ai": zAiProvider,
	openai: openAiResponsesProvider,
	codex: openAiResponsesProvider,
	"chatgpt-subscription": chatgptSubscriptionProvider,
	google: googleProvider,
	anthropic: anthropicProvider,
	perplexity: perplexityProvider,
	xai: xaiProvider,
	kimi: kimiProvider,
	kagi: kagiProvider,
	startpage: startpageProvider,
	mojeek: mojeekProvider,
	ecosia: ecosiaProvider,
	"google-html": googleHtmlProvider,
	"exa-mcp": exaMcpProvider,
	searxng: searxngProvider,
	keenable: keenableProvider,
};

function buildContext(config: SearchProviderConfig, request: SearchRequest): BuildContext {
	const { allowedDomains, blockedDomains } = resolveDomainFilters(config, request);
	return { config, request, maxResults: config.maxResults ?? request.maxResults, allowedDomains, blockedDomains };
}

/** A provider's own body parser (for example a full server-sent event stream), or undefined to use its response format. */
export function parseProviderBody(provider: SearchProvider, bodyText: string): JsonObject | undefined {
	return PROVIDER_MODULES[provider].parseBody?.(bodyText);
}

export function buildSearchRequest(config: SearchProviderConfig, request: SearchRequest): BuiltSearchRequest {
	return PROVIDER_MODULES[config.provider].buildRequest(buildContext(config, request));
}

/** Builds the request to send, running the provider's handshake first when it has one. */
export async function prepareSearchRequest(
	config: SearchProviderConfig,
	request: SearchRequest,
	fetchPage: PageFetcher,
): Promise<BuiltSearchRequest | { challenge: string }> {
	const module = PROVIDER_MODULES[config.provider];
	const ctx = buildContext(config, request);
	const built = module.buildRequest(ctx);
	return module.prepareRequest ? module.prepareRequest(ctx, built, fetchPage) : built;
}

export function searchResponseFormat(provider: SearchProvider): ResponseFormat {
	return PROVIDER_MODULES[provider].responseFormat ?? "json";
}

export function detectSearchChallenge(provider: SearchProvider, page: FetchedPage): string | undefined {
	return PROVIDER_MODULES[provider].detectChallenge?.(page);
}

export function searchResponseError(provider: SearchProvider, payload: unknown): string | undefined {
	return PROVIDER_MODULES[provider].responseError?.(parseObjectPayload(payload));
}

export async function normalizeSearchResponse(provider: SearchProvider, payload: unknown): Promise<SearchResultItem[]> {
	const module = PROVIDER_MODULES[provider];
	const data = parseObjectPayload(payload);
	if (module.normalizeDocument) {
		const html = typeof data.html === "string" ? data.html : "";
		return module.normalizeDocument(await parseHtmlDocument(html));
	}
	return module.normalizeResponse?.(data) ?? [];
}
