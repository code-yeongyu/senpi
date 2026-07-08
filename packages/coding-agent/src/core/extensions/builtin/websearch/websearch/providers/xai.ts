import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import { normalizeResponsesPayload } from "./openai-responses.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { contentHeaders } from "./shared.ts";

export const xaiProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const webSearchTool: JsonObject = { type: "web_search" };
		if (allowedDomains) webSearchTool.filters = { allowed_domains: allowedDomains.slice(0, 5) };
		if (!allowedDomains && blockedDomains) webSearchTool.filters = { excluded_domains: blockedDomains.slice(0, 5) };
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body: {
				model: config.model ?? "grok-4.3",
				input: request.query,
				tools: [webSearchTool],
				tool_choice: "required",
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeResponsesPayload(data, { citationsFallback: true });
	},
};
