import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { clamp, collect, contentHeaders, getArray, getNumber, getObject, getString, result } from "./shared.ts";

export const tavilyProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const body: JsonObject = { query: request.query, max_results: clamp(maxResults, 1, 20) };
		if (allowedDomains) body.include_domains = allowedDomains;
		if (blockedDomains) body.exclude_domains = blockedDomains;
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data.results).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.title),
					getString(item?.url),
					getString(item?.content),
					undefined,
					getNumber(item?.score),
				);
			}),
		);
	},
};
