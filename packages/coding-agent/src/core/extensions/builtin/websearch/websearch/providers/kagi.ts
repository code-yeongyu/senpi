import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { clamp, collect, contentHeaders, getArray, getObject, getString, result } from "./shared.ts";

export const kagiProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const body: JsonObject = { query: request.query, limit: clamp(maxResults, 1, 20) };
		if (allowedDomains || blockedDomains) {
			const lens: JsonObject = {};
			if (allowedDomains) lens.sites_included = allowedDomains;
			if (blockedDomains) lens.sites_excluded = blockedDomains;
			body.lens = lens;
		}
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const search = getObject(data.data);
		return collect(
			getArray(search?.search).map((raw) => {
				const item = getObject(raw);
				const normalized = result(getString(item?.title), getString(item?.url), getString(item?.snippet));
				if (normalized) {
					const publishedAt = getString(item?.time);
					if (publishedAt) normalized.publishedAt = publishedAt;
				}
				return normalized;
			}),
		);
	},
};
