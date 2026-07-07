import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import {
	appendDomainFilters,
	collect,
	contentHeaders,
	getArray,
	getObject,
	getString,
	result,
	unique,
} from "./shared.ts";

function searchOnlyPrompt(query: string): string {
	return `Find web pages matching any of these search terms or quoted phrases. If the query contains OR, search each alternative independently. Return only relevant source URLs, one per line. Query: ${query}`;
}

function resultsFromTextUrls(text: string | undefined): SearchResultItem[] {
	if (!text) return [];
	const urls = text.match(/https?:\/\/[^\s)\]}>"]+/g) ?? [];
	return collect(
		unique(urls).map((url) => {
			const cleaned = url.replace(/[.,;:]+$/, "");
			return result(cleaned, cleaned, text);
		}),
	);
}

export function buildResponsesRequest({
	config,
	request,
	allowedDomains,
	blockedDomains,
}: BuildContext): BuiltSearchRequest {
	const webSearchTool: JsonObject = {
		type: "web_search",
		external_web_access: (config.codexMode ?? "live") === "live",
	};
	if (config.searchContextSize) webSearchTool.search_context_size = config.searchContextSize;
	if (allowedDomains) webSearchTool.filters = { allowed_domains: allowedDomains };
	if (config.userLocation) webSearchTool.user_location = { type: "approximate", ...config.userLocation };
	const input = searchOnlyPrompt(
		blockedDomains ? appendDomainFilters(request.query, undefined, blockedDomains) : request.query,
	);

	return {
		url: providerUrl(config),
		init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
		body: {
			model: config.model ?? "gpt-5.5",
			input,
			tools: [webSearchTool],
			include: ["web_search_call.action.sources"],
			tool_choice: "required",
		},
	};
}

export function normalizeResponsesPayload(
	data: JsonObject,
	options: { citationsFallback: boolean },
): SearchResultItem[] {
	const output = getArray(data.output);
	const sources = collect(
		output.flatMap((raw) => {
			const item = getObject(raw);
			if (item?.type !== "web_search_call") return [];
			const action = getObject(item.action);
			return getArray(action?.sources).map((sourceRaw) => {
				const source = getObject(sourceRaw);
				const url = getString(source?.url);
				return result(url, url);
			});
		}),
	);
	const message = output.map(getObject).find((item) => item?.type === "message");
	const content = getArray(message?.content)
		.map(getObject)
		.find((item) => item?.type === "output_text");
	const text = getString(content?.text);
	const annotationResults = collect(
		getArray(content?.annotations).map((raw) => {
			const item = getObject(raw);
			return item?.type === "url_citation" ? result(getString(item.title), getString(item.url), text) : null;
		}),
	);
	if (annotationResults.length > 0) return annotationResults;
	if (sources.length > 0) {
		return sources.map((source) => {
			if (source.snippet || text === undefined) return source;
			return { ...source, snippet: text };
		});
	}
	const textUrls = resultsFromTextUrls(text);
	if (textUrls.length > 0) return textUrls;
	if (!options.citationsFallback) return annotationResults;
	return collect(
		getArray(data.citations).map((raw) => {
			const url = getString(raw);
			return result(url, url, text);
		}),
	);
}

export const openAiResponsesProvider: ProviderModule = {
	buildRequest(ctx: BuildContext): BuiltSearchRequest {
		return buildResponsesRequest(ctx);
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeResponsesPayload(data, { citationsFallback: false });
	},
};
