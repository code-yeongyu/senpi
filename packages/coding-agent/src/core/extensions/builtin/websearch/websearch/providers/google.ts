import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import {
	appendDomainFilters,
	collect,
	contentHeaders,
	getArray,
	getNumber,
	getObject,
	getString,
	result,
	withConfigHeaders,
} from "./shared.ts";

const DEFAULT_MODEL = "gemini-2.5-flash";

function generateContentUrl(config: BuildContext["config"]): string {
	const root = providerUrl(config).replace(/\/+$/, "");
	if (root.endsWith(":generateContent")) return root;
	const model = (config.model ?? DEFAULT_MODEL).replace(/^models\//, "");
	return `${root}/models/${encodeURIComponent(model)}:generateContent`;
}

function buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
	const query = appendDomainFilters(request.query, allowedDomains, blockedDomains);
	const prompt = `Search the web with Google Search and answer briefly, citing the pages you used. Query: ${query}`;
	return {
		url: generateContentUrl(config),
		init: {
			method: "POST",
			headers: withConfigHeaders(config, contentHeaders({ "x-goog-api-key": config.apiKey ?? "" })),
		},
		body: {
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			tools: [{ google_search: {} }],
		},
	};
}

function supportSnippets(metadata: JsonObject | undefined): Map<number, string> {
	const snippets = new Map<number, string>();
	for (const rawSupport of getArray(metadata?.groundingSupports)) {
		const support = getObject(rawSupport);
		const text = getString(getObject(support?.segment)?.text);
		if (!text) continue;
		for (const rawIndex of getArray(support?.groundingChunkIndices)) {
			const index = getNumber(rawIndex);
			if (index !== undefined && !snippets.has(index)) snippets.set(index, text);
		}
	}
	return snippets;
}

/** Grounding chunks are the only results; an answer the model gave without grounding yields none. */
function normalizeResponse(data: JsonObject): SearchResultItem[] {
	return collect(
		getArray(data.candidates).flatMap((rawCandidate) => {
			const metadata = getObject(getObject(rawCandidate)?.groundingMetadata);
			const snippets = supportSnippets(metadata);
			return getArray(metadata?.groundingChunks).map((rawChunk, index) => {
				const web = getObject(getObject(rawChunk)?.web);
				const url = getString(web?.uri);
				return result(getString(web?.title) ?? url, url, snippets.get(index));
			});
		}),
	);
}

export const googleProvider: ProviderModule = { buildRequest, normalizeResponse };
