import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, JsonValue, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { clamp, collect, contentHeaders, getArray, getObject, getString, result } from "./shared.ts";

function normalizeResultList(items: JsonValue[]): SearchResultItem[] {
	return collect(
		items.map((raw) => {
			const item = getObject(raw);
			const searchResult = result(getString(item?.title), getString(item?.url), getString(item?.snippet));
			if (searchResult) {
				const publishedAt = getString(item?.date) ?? getString(item?.last_updated);
				if (publishedAt) searchResult.publishedAt = publishedAt;
			}
			return searchResult;
		}),
	);
}

export const perplexityProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		if (config.model) {
			const body: JsonObject = {
				model: config.model,
				messages: [{ role: "user", content: request.query }],
			};
			if (allowedDomains) body.search_domain_filter = allowedDomains;
			if (!allowedDomains && blockedDomains)
				body.search_domain_filter = blockedDomains.map((domain) => `-${domain}`);
			if (config.searchContextSize) body.web_search_options = { search_context_size: config.searchContextSize };
			return {
				url: providerUrl(config),
				init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
				body,
			};
		}

		const body: JsonObject = { query: request.query, max_results: clamp(maxResults, 1, 20) };
		if (allowedDomains) body.search_domain_filter = allowedDomains;
		if (!allowedDomains && blockedDomains) body.search_domain_filter = blockedDomains.map((domain) => `-${domain}`);
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const chatResults = normalizeResultList(getArray(data.search_results));
		if (chatResults.length > 0) return chatResults;
		return normalizeResultList(getArray(data.results));
	},
};
