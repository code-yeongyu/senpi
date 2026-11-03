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

function webResults(data: JsonObject): JsonObject[] {
	const nested = getArray(getObject(data.data)?.web);
	const rows = nested.length > 0 ? nested : getArray(data.data);
	return (rows.length > 0 ? rows : getArray(data.results))
		.map(getObject)
		.filter((item): item is JsonObject => item !== undefined);
}

function firecrawlError(data: JsonObject): string | undefined {
	if (data.success !== false) return undefined;
	return getString(data.error)?.trim() || "Firecrawl request failed";
}

export const firecrawlProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const apiKey = config.apiKey;
		return {
			url: providerUrl(config),
			init: {
				method: "POST",
				headers: contentHeaders(apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined),
			},
			body: {
				query: appendDomainFilters(request.query, allowedDomains, blockedDomains),
				limit: clamp(maxResults, 1, 100),
				sources: [{ type: "web" }],
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			webResults(data).map((item) => {
				const url = getString(item.url);
				if (!url) return null;
				return result(
					getString(item.title) ?? url,
					url,
					getString(item.description) ?? getString(item.snippet) ?? getString(item.markdown),
				);
			}),
		);
	},
	responseError: firecrawlError,
};
