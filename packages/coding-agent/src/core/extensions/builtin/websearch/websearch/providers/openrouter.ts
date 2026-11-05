import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import {
	clamp,
	collect,
	contentHeaders,
	getArray,
	getObject,
	getString,
	httpUrl,
	result,
	uniqueByUrl,
} from "./shared.ts";

/** `baseUrl` is the API root (`https://openrouter.ai/api/v1`), so the chat-completions path is appended once. */
function chatCompletionsUrl(config: BuildContext["config"]): string {
	const root = providerUrl(config).replace(/\/+$/, "");
	return root.endsWith("/chat/completions") ? root : `${root}/chat/completions`;
}

/**
 * The `url_citation` annotations are the only results: the web plugin grounds the answer it writes, and an
 * answer without annotations is no results at all (the search flow reports it as an error). URLs the model
 * writes in its own answer text were never returned by a search, so they are never sources (senpi#2337).
 */
function normalizeResponse(data: JsonObject): SearchResultItem[] {
	const message = getObject(getObject(getArray(data.choices)[0])?.message);
	return uniqueByUrl(
		collect(
			getArray(message?.annotations).map((raw) => {
				const annotation = getObject(raw);
				const type = getString(annotation?.type);
				if (type !== undefined && type !== "url_citation") return null;
				const citation = getObject(annotation?.url_citation);
				const url = httpUrl(getString(citation?.url));
				if (!url) return null;
				return result(getString(citation?.title) ?? url, url, getString(citation?.content));
			}),
		),
	);
}

export const openRouterProvider: ProviderModule = {
	buildRequest({ config, request, maxResults }: BuildContext): BuiltSearchRequest {
		const body: JsonObject = {
			plugins: [{ id: "web", max_results: clamp(maxResults, 1, 50) }],
			messages: [{ role: "user", content: request.query }],
		};
		if (config.model) body.model = config.model;
		return {
			url: chatCompletionsUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	},
	normalizeResponse,
};
