import { arch, platform, release } from "node:os";
import { extractChatGptSubscriptionAccountId, getWireIdentity } from "@earendil-works/pi-ai";

import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import { collectResponseStream } from "./response-stream.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import {
	appendDomainFilters,
	collect,
	getArray,
	getNumber,
	getObject,
	getString,
	result,
	withConfigHeaders,
} from "./shared.ts";

const DEFAULT_MODEL = "gpt-5.5";
const INSTRUCTIONS =
	"You are a web search assistant. Always run the web_search tool for the user's query, then answer briefly and cite the pages you used.";

function requestHeaders(config: BuildContext["config"]): Record<string, string> {
	const token = config.apiKey ?? "";
	const identity = getWireIdentity();
	const headers = withConfigHeaders(config, {
		Authorization: `Bearer ${token}`,
		"OpenAI-Beta": "responses=experimental",
		originator: identity,
		"User-Agent": `${identity} (${platform()} ${release()}; ${arch()})`,
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	});
	const accountId = extractChatGptSubscriptionAccountId(token);
	if (accountId) headers["chatgpt-account-id"] = accountId;
	else delete headers["chatgpt-account-id"];
	return headers;
}

function buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
	const webSearchTool: JsonObject = {
		type: "web_search",
		external_web_access: (config.codexMode ?? "live") === "live",
	};
	if (config.searchContextSize) webSearchTool.search_context_size = config.searchContextSize;
	if (allowedDomains) webSearchTool.filters = { allowed_domains: allowedDomains };
	if (config.userLocation) webSearchTool.user_location = { type: "approximate", ...config.userLocation };
	const query = blockedDomains ? appendDomainFilters(request.query, undefined, blockedDomains) : request.query;

	return {
		url: providerUrl(config),
		init: { method: "POST", headers: requestHeaders(config) },
		body: {
			model: config.model ?? DEFAULT_MODEL,
			instructions: INSTRUCTIONS,
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
			tools: [webSearchTool],
			tool_choice: { type: "web_search" },
			include: ["web_search_call.action.sources"],
			store: false,
			stream: true,
		},
	};
}

function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		return url.href;
	} catch {
		return rawUrl;
	}
}

function citationSnippet(text: string, start: number | undefined, end: number | undefined): string | undefined {
	if (start === undefined || end === undefined) return undefined;
	const snippet = text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100)).trim();
	return snippet || undefined;
}

function citationResults(output: Array<JsonObject | undefined>): Array<SearchResultItem | null> {
	return output.flatMap((item) =>
		item?.type !== "message"
			? []
			: getArray(item.content).flatMap((rawPart) => {
					const part = getObject(rawPart);
					const text = getString(part?.text) ?? "";
					return getArray(part?.annotations).map((rawAnnotation) => {
						const annotation = getObject(rawAnnotation);
						const url = getString(annotation?.url);
						if (annotation?.type !== "url_citation" || !url) return null;
						const snippet = citationSnippet(
							text,
							getNumber(annotation.start_index),
							getNumber(annotation.end_index),
						);
						return result(getString(annotation.title) ?? url, cleanSourceUrl(url), snippet);
					});
				}),
	);
}

function sourceResults(searchCalls: Array<JsonObject | undefined>): Array<SearchResultItem | null> {
	return searchCalls.flatMap((call) =>
		getArray(getObject(call?.action)?.sources).map((rawSource) => {
			const source = getObject(rawSource);
			const url = getString(source?.url);
			return url ? result(getString(source?.title) ?? url, cleanSourceUrl(url)) : null;
		}),
	);
}

/** Only a reply that ran web_search counts; its citations and search sources are the results, never URLs typed in the answer. */
function normalizeResponse(data: JsonObject): SearchResultItem[] {
	const output = getArray(data.output).map(getObject);
	const searchCalls = output.filter((item) => item?.type === "web_search_call");
	if (searchCalls.length === 0) return [];
	const byUrl = new Map<string, SearchResultItem>();
	for (const item of collect([...citationResults(output), ...sourceResults(searchCalls)], Number.MAX_SAFE_INTEGER)) {
		if (!byUrl.has(item.url)) byUrl.set(item.url, item);
	}
	return collect([...byUrl.values()]);
}

export const chatgptSubscriptionProvider: ProviderModule = {
	buildRequest,
	normalizeResponse,
	parseBody: collectResponseStream,
};
