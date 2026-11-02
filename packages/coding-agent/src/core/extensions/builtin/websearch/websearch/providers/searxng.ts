import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { appendDomainFilters, collect, getArray, getObject, getString, result, uniqueByUrl } from "./shared.ts";

function searxngSearchUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/search$/, "")}/search`;
	return url;
}

function normalizeSearxngResponse(data: JsonObject): SearchResultItem[] {
	return uniqueByUrl(
		collect(
			getArray(data.results).map((value) => {
				const entry = getObject(value);
				if (!entry) return null;
				const url = getString(entry.url);
				const item = result(getString(entry.title) ?? url, url, getString(entry.content)?.trim() || undefined);
				const published = getString(entry.publishedDate);
				if (item && published) item.publishedAt = published;
				return item;
			}),
		),
	);
}

export const searxngProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const url = searxngSearchUrl(providerUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		url.searchParams.set("format", "json");
		return { url: url.toString(), init: { method: "GET", headers: { Accept: "application/json" } } };
	},
	normalizeResponse: normalizeSearxngResponse,
};
