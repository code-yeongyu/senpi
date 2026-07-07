import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { collect, contentHeaders, getArray, getObject, getString, result } from "./shared.ts";

export const anthropicProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const webSearchTool: JsonObject = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
		if (allowedDomains) webSearchTool.allowed_domains = allowedDomains;
		if (blockedDomains) webSearchTool.blocked_domains = blockedDomains;
		return {
			url: providerUrl(config),
			init: {
				method: "POST",
				headers: contentHeaders({
					"x-api-key": config.apiKey ?? "",
					"anthropic-version": "2023-06-01",
				}),
			},
			body: {
				model: config.model ?? "claude-sonnet-4-5-20250929",
				max_tokens: 1024,
				messages: [{ role: "user", content: request.query }],
				tools: [webSearchTool],
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const content = getArray(data.content);
		const text = content
			.map(getObject)
			.map((item) => getString(item?.text))
			.filter((value): value is string => value !== undefined)
			.join("\n");
		return collect(
			content.flatMap((raw) => {
				const item = getObject(raw);
				if (item?.type !== "web_search_tool_result") return [];
				return getArray(item.content).map((searchRaw) => {
					const searchItem = getObject(searchRaw);
					return result(
						getString(searchItem?.title),
						getString(searchItem?.url),
						getString(searchItem?.page_age) ?? text,
					);
				});
			}),
		);
	},
};
