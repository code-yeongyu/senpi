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

export const serperProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const body: JsonObject = {
			q: appendDomainFilters(request.query, allowedDomains, blockedDomains),
			num: clamp(maxResults, 1, 20),
		};
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ "X-API-KEY": config.apiKey ?? "" }) },
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data.organic).map((raw) => {
				const item = getObject(raw);
				return result(getString(item?.title), getString(item?.link), getString(item?.snippet));
			}),
		);
	},
};
