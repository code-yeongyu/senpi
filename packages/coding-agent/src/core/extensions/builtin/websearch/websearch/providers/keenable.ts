import { APP_NAME } from "../../../../../../config.ts";
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

/** Keyless twin of the default endpoint; identified by `X-Keenable-Title` instead of a key. */
const PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";

/** Accepts only absolute http(s) URLs; control characters would let text merge into the URL on parse. */
function httpUrl(value: string | undefined): string | undefined {
	if (!value || value.length > 2048 || /[\t\n\r]/.test(value)) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

export const keenableProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		// A lone allowed domain maps to the native host-only `site` field; anything else
		// (multiple domains, exclusions) stays as `site:`/`-site:` terms in the query.
		const site = allowedDomains?.length === 1 ? allowedDomains[0] : undefined;
		const body: JsonObject = {
			query: appendDomainFilters(request.query, site ? undefined : allowedDomains, blockedDomains),
			max_results: clamp(maxResults, 1, 50),
		};
		if (site) body.site = site;
		const keyed = typeof config.apiKey === "string" && config.apiKey.length > 0;
		return {
			url: keyed || config.baseUrl ? providerUrl(config) : PUBLIC_SEARCH_URL,
			init: {
				method: "POST",
				headers: contentHeaders(keyed ? { "X-API-Key": config.apiKey ?? "" } : { "X-Keenable-Title": APP_NAME }),
			},
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data.results).map((raw) => {
				const item = getObject(raw);
				const url = httpUrl(getString(item?.url));
				if (!item || !url) return null;
				const normalized = result(
					getString(item.title) ?? url,
					url,
					getString(item.snippet) ?? getString(item.description),
				);
				if (normalized) {
					const publishedAt = getString(item.published_at);
					if (publishedAt) normalized.publishedAt = publishedAt;
				}
				return normalized;
			}),
		);
	},
};
