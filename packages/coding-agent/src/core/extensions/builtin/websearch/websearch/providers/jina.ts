import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { appendDomainFilters, clamp, collect, getArray, getObject, getString, result } from "./shared.ts";

/**
 * Jina Reader search: the query travels in the URL path, `count` carries the result count, and
 * `X-Respond-With: no-content` keeps the answer to titles and descriptions instead of page text.
 */
export const jinaProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		// A lone allowed domain maps to Jina's native host-only `X-Site` filter; anything else
		// (multiple domains, exclusions) stays as `site:`/`-site:` terms in the query.
		const site = allowedDomains?.length === 1 ? allowedDomains[0]?.split("/")[0] : undefined;
		const query = appendDomainFilters(request.query, site ? undefined : allowedDomains, blockedDomains);
		const url = new URL(`${providerUrl(config).replace(/\/+$/, "")}/${encodeURIComponent(query)}`);
		url.searchParams.set("count", String(clamp(maxResults, 1, 20)));
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${config.apiKey ?? ""}`,
			"X-Respond-With": "no-content",
			"X-Retain-Images": "none",
		};
		if (site) headers["X-Site"] = site;
		return { url: url.toString(), init: { method: "GET", headers } };
	},
	responseError(data: JsonObject): string | undefined {
		const code = data.code;
		return typeof code === "number" && code !== 200 ? `Jina API response reported failure (${code})` : undefined;
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data.data).map((raw) => {
				const item = getObject(raw);
				const url = getString(item?.url);
				if (!url) return null;
				return result(getString(item?.title) ?? url, url, getString(item?.description) ?? getString(item?.content));
			}),
		);
	},
};
