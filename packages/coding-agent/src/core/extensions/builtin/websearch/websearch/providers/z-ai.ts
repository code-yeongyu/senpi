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

export const zAiProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		if (config.model) {
			const webSearch: JsonObject = {
				enable: true,
				search_engine: "search-prime",
				search_result: true,
				count: clamp(maxResults, 1, 50),
			};
			if (allowedDomains?.[0]) webSearch.search_domain_filter = allowedDomains[0];
			if (config.searchContextSize) webSearch.content_size = config.searchContextSize;
			return {
				url: providerUrl(config),
				init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
				body: {
					model: config.model,
					messages: [{ role: "user", content: request.query }],
					tools: [{ type: "web_search", web_search: webSearch }],
				},
			};
		}

		const body: JsonObject = {
			search_engine: "search-prime",
			search_query: appendDomainFilters(request.query, undefined, blockedDomains),
			count: clamp(maxResults, 1, 50),
		};
		if (allowedDomains?.[0]) body.search_domain_filter = allowedDomains[0];
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const chatResults = collect(
			getArray(data.web_search).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.title),
					getString(item?.link),
					getString(item?.content),
					getString(item?.media),
				);
			}),
		);
		if (chatResults.length > 0) return chatResults;

		return collect(
			getArray(data.search_result).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.title),
					getString(item?.link),
					getString(item?.content),
					getString(item?.media),
				);
			}),
		);
	},
};
