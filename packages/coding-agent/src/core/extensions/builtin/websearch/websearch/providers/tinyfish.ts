import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchProviderConfig, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { cleanText, clamp, collect, getArray, getObject, getString, result } from "./shared.ts";

/** TinyFish serves at most ten results per page; a larger count fetches consecutive pages. */
const MAX_PAGE_RESULTS = 10;
/** Pagination stops after ten fetched pages (page 0 through page 9). */
const MAX_PAGES = 10;

function resultCount(maxResults: number): number {
	return clamp(maxResults, 1, 20);
}

function tinyfishRequest(
	config: SearchProviderConfig,
	query: string,
	count: number,
	allowedDomains: string[] | undefined,
	blockedDomains: string[] | undefined,
	page: number,
): BuiltSearchRequest {
	const url = new URL(providerUrl(config));
	url.searchParams.set("query", query);
	if (allowedDomains?.length) url.searchParams.set("include_domains", allowedDomains.join(","));
	if (blockedDomains?.length) url.searchParams.set("exclude_domains", blockedDomains.join(","));
	url.searchParams.set("num_results", String(Math.min(count, MAX_PAGE_RESULTS)));
	url.searchParams.set("page", String(page));
	return {
		url: url.toString(),
		init: { method: "GET", headers: { Accept: "application/json", "X-API-Key": config.apiKey ?? "" } },
	};
}

export const tinyfishProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		return tinyfishRequest(config, request.query, resultCount(maxResults), allowedDomains, blockedDomains, 0);
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data.results).map((raw) => {
				const item = getObject(raw);
				const url = getString(item?.url);
				if (!item || !url) return null;
				const title = getString(item.title) ?? getString(item.site_name) ?? url;
				return result(title, url, cleanText(getString(item.snippet)));
			}),
		);
	},
	nextPage({ config, request, maxResults, allowedDomains, blockedDomains }, _page, payload, pageIndex) {
		if (pageIndex + 1 >= MAX_PAGES) return undefined;
		const count = resultCount(maxResults);
		if (getArray(getObject(payload)?.results).length < Math.min(count, MAX_PAGE_RESULTS)) return undefined;
		return tinyfishRequest(config, request.query, count, allowedDomains, blockedDomains, pageIndex + 1);
	},
};
