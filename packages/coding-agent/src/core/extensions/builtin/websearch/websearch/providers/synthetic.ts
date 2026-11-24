import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { appendDomainFilters, collect, contentHeaders, getArray, getObject, getString, result } from "./shared.ts";

export const syntheticProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body: { query: appendDomainFilters(request.query, allowedDomains, blockedDomains) },
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data.results).map((raw) => {
				const item = getObject(raw);
				const normalized = result(
					getString(item?.title) ?? getString(item?.url),
					getString(item?.url),
					getString(item?.text),
				);
				if (normalized) {
					const publishedAt = getString(item?.published);
					if (publishedAt) normalized.publishedAt = publishedAt;
				}
				return normalized;
			}),
		);
	},
};
