import { anthropicProvider } from "./providers/anthropic.ts";
import { braveProvider } from "./providers/brave.ts";
import { duckDuckGoHtmlProvider } from "./providers/duckduckgo-html.ts";
import { exaProvider } from "./providers/exa.ts";
import { googleCseProvider } from "./providers/google-cse.ts";
import { kimiProvider } from "./providers/kimi.ts";
import { openAiResponsesProvider } from "./providers/openai-responses.ts";
import { perplexityProvider } from "./providers/perplexity.ts";
import { serperProvider } from "./providers/serper.ts";
import type { ProviderModule } from "./providers/shared.ts";
import { parseObjectPayload, resolveDomainFilters } from "./providers/shared.ts";
import { tavilyProvider } from "./providers/tavily.ts";
import { xaiProvider } from "./providers/xai.ts";
import { zAiProvider } from "./providers/z-ai.ts";
import type {
	BuiltSearchRequest,
	SearchProvider,
	SearchProviderConfig,
	SearchRequest,
	SearchResultItem,
} from "./types.ts";

const PROVIDER_MODULES: Record<SearchProvider, ProviderModule> = {
	exa: exaProvider,
	tavily: tavilyProvider,
	brave: braveProvider,
	"duckduckgo-html": duckDuckGoHtmlProvider,
	serper: serperProvider,
	"google-cse": googleCseProvider,
	"z-ai": zAiProvider,
	openai: openAiResponsesProvider,
	codex: openAiResponsesProvider,
	anthropic: anthropicProvider,
	perplexity: perplexityProvider,
	xai: xaiProvider,
	kimi: kimiProvider,
};

export function buildSearchRequest(config: SearchProviderConfig, request: SearchRequest): BuiltSearchRequest {
	const maxResults = config.maxResults ?? request.maxResults;
	const { allowedDomains, blockedDomains } = resolveDomainFilters(config, request);
	return PROVIDER_MODULES[config.provider].buildRequest({
		config,
		request,
		maxResults,
		allowedDomains,
		blockedDomains,
	});
}

export function normalizeSearchResponse(provider: SearchProvider, payload: unknown): SearchResultItem[] {
	return PROVIDER_MODULES[provider].normalizeResponse(parseObjectPayload(payload));
}
