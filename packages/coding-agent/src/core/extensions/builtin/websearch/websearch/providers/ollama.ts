/**
 * Ollama Web Search Provider
 *
 * Calls Ollama's hosted web search REST API and maps results into the unified
 * search result shape. Endpoint: POST https://ollama.com/api/web_search
 */
import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import {
	appendDomainFilters,
	clamp,
	collect,
	contentHeaders,
	getArray,
	getObject,
	getString,
	result,
} from "./shared.ts";

export const ollamaProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body: {
				query: appendDomainFilters(request.query, allowedDomains, blockedDomains),
				max_results: clamp(maxResults, 1, 10),
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data.results).map((raw) => {
				const item = getObject(raw);
				const url = getString(item?.url);
				if (!item || !url) return null;
				return result(getString(item.title) ?? url, url, getString(item.content));
			}),
		);
	},
};
