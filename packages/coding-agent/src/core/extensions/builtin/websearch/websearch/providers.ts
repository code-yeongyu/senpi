import { providerUrl } from "./provider-endpoints.ts";
import type {
	BuiltSearchRequest,
	JsonObject,
	JsonValue,
	SearchProvider,
	SearchProviderConfig,
	SearchRequest,
	SearchResultItem,
} from "./types.ts";

const EMPTY_DOMAIN_SENTINEL = "invalid.invalid";

function contentHeaders(extra?: Record<string, string>): Record<string, string> {
	return { Accept: "application/json", "Content-Type": "application/json", ...(extra ?? {}) };
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function appendDomainFilters(query: string, allowedDomains?: string[], blockedDomains?: string[]): string {
	const parts = [query];
	for (const domain of allowedDomains ?? []) parts.push(`site:${domain}`);
	for (const domain of blockedDomains ?? []) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function nonEmptyDomains(values: string[]): string[] {
	return values.length > 0 ? values : [EMPTY_DOMAIN_SENTINEL];
}

function resolveDomainFilters(
	config: SearchProviderConfig,
	request: SearchRequest,
): { allowedDomains?: string[]; blockedDomains?: string[] } {
	const configAllowed = config.allowedDomains;
	const configBlocked = config.blockedDomains;
	const requestAllowed = request.allowedDomains;
	const requestBlocked = request.blockedDomains;

	if (configAllowed) {
		const narrowed = requestAllowed
			? configAllowed.filter((domain) => requestAllowed.includes(domain))
			: configAllowed;
		const allowed = requestBlocked ? narrowed.filter((domain) => !requestBlocked.includes(domain)) : narrowed;
		return { allowedDomains: nonEmptyDomains(unique(allowed)) };
	}

	if (configBlocked) {
		const blocked = unique([...configBlocked, ...(requestBlocked ?? [])]);
		if (requestAllowed) {
			return { allowedDomains: nonEmptyDomains(requestAllowed.filter((domain) => !blocked.includes(domain))) };
		}
		return { blockedDomains: blocked };
	}

	if (requestAllowed) return { allowedDomains: unique(requestAllowed) };
	if (requestBlocked) return { blockedDomains: unique(requestBlocked) };
	return {};
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getObject(value: JsonValue | undefined): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function getArray(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value : [];
}

function getString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function getNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function result(
	title: string | undefined,
	url: string | undefined,
	snippet?: string,
	source?: string,
	score?: number,
): SearchResultItem | null {
	if (!title || !url) return null;
	const item: SearchResultItem = { title, url };
	if (snippet) item.snippet = snippet;
	if (source) item.source = source;
	if (score !== undefined) item.score = score;
	return item;
}

function htmlDecode(value: string): string {
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">");
}

function stripHtml(value: string): string {
	return htmlDecode(
		value
			.replace(/<[^>]*>/g, "")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

function duckDuckGoResultUrl(rawHref: string): string | undefined {
	const decodedHref = htmlDecode(rawHref);
	const absoluteHref = decodedHref.startsWith("//") ? `https:${decodedHref}` : decodedHref;
	let url: URL;
	try {
		url = new URL(absoluteHref);
	} catch {
		return undefined;
	}
	const redirected = url.searchParams.get("uddg");
	return redirected ?? absoluteHref;
}

function normalizeDuckDuckGoHtml(html: string): SearchResultItem[] {
	const matches = [...html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map(
		(match) => stripHtml(match[1] ?? ""),
	);
	return collect(
		matches.map((match, index) => {
			const title = stripHtml(match[2] ?? "");
			const url = duckDuckGoResultUrl(match[1] ?? "");
			return result(title, url, snippets[index]);
		}),
	);
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

function searchOnlyPrompt(query: string): string {
	return `Find web pages matching any of these search terms or quoted phrases. If the query contains OR, search each alternative independently. Return only relevant source URLs, one per line. Query: ${query}`;
}

function collect(items: Array<SearchResultItem | null>, max = 50): SearchResultItem[] {
	return items.filter((item): item is SearchResultItem => item !== null).slice(0, max);
}

function parseObjectPayload(payload: unknown): JsonObject {
	if (isJsonObject(payload)) return payload;
	return {};
}

export function buildSearchRequest(config: SearchProviderConfig, request: SearchRequest): BuiltSearchRequest {
	const maxResults = config.maxResults ?? request.maxResults;
	const { allowedDomains, blockedDomains } = resolveDomainFilters(config, request);

	if (config.provider === "exa") {
		const headers = contentHeaders({ "x-api-key": config.apiKey ?? "" });
		const body: JsonObject = { query: request.query, numResults: clamp(maxResults, 1, 20) };
		if (allowedDomains) body["includeDomains"] = allowedDomains;
		if (blockedDomains) body["excludeDomains"] = blockedDomains;
		return { url: providerUrl(config), init: { method: "POST", headers }, body };
	}

	if (config.provider === "tavily") {
		const body: JsonObject = { query: request.query, max_results: clamp(maxResults, 1, 20) };
		if (allowedDomains) body["include_domains"] = allowedDomains;
		if (blockedDomains) body["exclude_domains"] = blockedDomains;
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	}

	if (config.provider === "brave") {
		const url = new URL(providerUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		url.searchParams.set("count", String(clamp(maxResults, 1, 20)));
		return {
			url: url.toString(),
			init: { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": config.apiKey ?? "" } },
		};
	}

	if (config.provider === "duckduckgo-html") {
		const url = new URL(providerUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		return { url: url.toString(), init: { method: "GET", headers: { Accept: "text/html" } } };
	}

	if (config.provider === "serper") {
		const body: JsonObject = {
			q: appendDomainFilters(request.query, allowedDomains, blockedDomains),
			num: clamp(maxResults, 1, 20),
		};
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ "X-API-KEY": config.apiKey ?? "" }) },
			body,
		};
	}

	if (config.provider === "google-cse") {
		const url = new URL(providerUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		url.searchParams.set("key", config.apiKey ?? "");
		url.searchParams.set("cx", config.searchEngineId ?? "");
		url.searchParams.set("num", String(clamp(maxResults, 1, 10)));
		return { url: url.toString(), init: { method: "GET", headers: { Accept: "application/json" } } };
	}

	if (config.provider === "z-ai") {
		if (config.model) {
			const webSearch: JsonObject = {
				enable: true,
				search_engine: "search-prime",
				search_result: true,
				count: clamp(maxResults, 1, 50),
			};
			if (allowedDomains?.[0]) webSearch["search_domain_filter"] = allowedDomains[0];
			if (config.searchContextSize) webSearch["content_size"] = config.searchContextSize;
			return {
				url: providerUrl(config),
				init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
				body: {
					model: config.model,
					messages: [{ role: "user", content: request.query }],
					tools: [{ type: "web_search", web_search: webSearch }],
				},
			};
		}

		const body: JsonObject = {
			search_engine: "search-prime",
			search_query: appendDomainFilters(request.query, undefined, blockedDomains),
			count: clamp(maxResults, 1, 50),
		};
		if (allowedDomains?.[0]) body["search_domain_filter"] = allowedDomains[0];
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	}

	if (config.provider === "perplexity") {
		if (config.model) {
			const body: JsonObject = {
				model: config.model,
				messages: [{ role: "user", content: request.query }],
			};
			if (allowedDomains) body["search_domain_filter"] = allowedDomains;
			if (!allowedDomains && blockedDomains)
				body["search_domain_filter"] = blockedDomains.map((domain) => `-${domain}`);
			if (config.searchContextSize) body["web_search_options"] = { search_context_size: config.searchContextSize };
			return {
				url: providerUrl(config),
				init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
				body,
			};
		}

		const body: JsonObject = { query: request.query, max_results: clamp(maxResults, 1, 20) };
		if (allowedDomains) body["search_domain_filter"] = allowedDomains;
		if (!allowedDomains && blockedDomains)
			body["search_domain_filter"] = blockedDomains.map((domain) => `-${domain}`);
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: contentHeaders({ Authorization: `Bearer ${config.apiKey ?? ""}` }) },
			body,
		};
	}

	if (config.provider === "xai") {
		const webSearchTool: JsonObject = { type: "web_search" };
		if (allowedDomains) webSearchTool["filters"] = { allowed_domains: allowedDomains.slice(0, 5) };
		if (!allowedDomains && blockedDomains)
			webSearchTool["filters"] = { excluded_domains: blockedDomains.slice(0, 5) };
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
	}

	if (config.provider === "anthropic") {
		const webSearchTool: JsonObject = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
		if (allowedDomains) webSearchTool["allowed_domains"] = allowedDomains;
		if (blockedDomains) webSearchTool["blocked_domains"] = blockedDomains;
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
	}

	const webSearchTool: JsonObject = {
		type: "web_search",
		external_web_access: (config.codexMode ?? "live") === "live",
	};
	if (config.searchContextSize) webSearchTool["search_context_size"] = config.searchContextSize;
	if (allowedDomains) webSearchTool["filters"] = { allowed_domains: allowedDomains };
	if (config.userLocation) webSearchTool["user_location"] = { type: "approximate", ...config.userLocation };
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

export function normalizeSearchResponse(provider: SearchProvider, payload: unknown): SearchResultItem[] {
	const data = parseObjectPayload(payload);

	if (provider === "exa") {
		return collect(
			getArray(data["results"]).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.["title"]),
					getString(item?.["url"]),
					getString(item?.["text"]) ?? getString(item?.["snippet"]),
					undefined,
					getNumber(item?.["score"]),
				);
			}),
		);
	}

	if (provider === "tavily") {
		return collect(
			getArray(data["results"]).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.["title"]),
					getString(item?.["url"]),
					getString(item?.["content"]),
					undefined,
					getNumber(item?.["score"]),
				);
			}),
		);
	}

	if (provider === "brave") {
		const web = getObject(data["web"]);
		return collect(
			getArray(web?.["results"]).map((raw) => {
				const item = getObject(raw);
				return result(getString(item?.["title"]), getString(item?.["url"]), getString(item?.["description"]));
			}),
		);
	}

	if (provider === "duckduckgo-html") {
		return normalizeDuckDuckGoHtml(getString(data["html"]) ?? "");
	}

	if (provider === "serper") {
		return collect(
			getArray(data["organic"]).map((raw) => {
				const item = getObject(raw);
				return result(getString(item?.["title"]), getString(item?.["link"]), getString(item?.["snippet"]));
			}),
		);
	}

	if (provider === "google-cse") {
		return collect(
			getArray(data["items"]).map((raw) => {
				const item = getObject(raw);
				return result(getString(item?.["title"]), getString(item?.["link"]), getString(item?.["snippet"]));
			}),
		);
	}

	if (provider === "z-ai") {
		const chatResults = collect(
			getArray(data["web_search"]).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.["title"]),
					getString(item?.["link"]),
					getString(item?.["content"]),
					getString(item?.["media"]),
				);
			}),
		);
		if (chatResults.length > 0) return chatResults;

		return collect(
			getArray(data["search_result"]).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.["title"]),
					getString(item?.["link"]),
					getString(item?.["content"]),
					getString(item?.["media"]),
				);
			}),
		);
	}

	if (provider === "perplexity") {
		const chatResults = collect(
			getArray(data["search_results"]).map((raw) => {
				const item = getObject(raw);
				const searchResult = result(
					getString(item?.["title"]),
					getString(item?.["url"]),
					getString(item?.["snippet"]),
				);
				if (searchResult) {
					const publishedAt = getString(item?.["date"]) ?? getString(item?.["last_updated"]);
					if (publishedAt) searchResult.publishedAt = publishedAt;
				}
				return searchResult;
			}),
		);
		if (chatResults.length > 0) return chatResults;

		return collect(
			getArray(data["results"]).map((raw) => {
				const item = getObject(raw);
				const searchResult = result(
					getString(item?.["title"]),
					getString(item?.["url"]),
					getString(item?.["snippet"]),
				);
				if (searchResult) {
					const publishedAt = getString(item?.["date"]) ?? getString(item?.["last_updated"]);
					if (publishedAt) searchResult.publishedAt = publishedAt;
				}
				return searchResult;
			}),
		);
	}

	if (provider === "anthropic") {
		const content = getArray(data["content"]);
		const text = content
			.map(getObject)
			.map((item) => getString(item?.["text"]))
			.filter((value): value is string => value !== undefined)
			.join("\n");
		return collect(
			content.flatMap((raw) => {
				const item = getObject(raw);
				if (item?.["type"] !== "web_search_tool_result") return [];
				return getArray(item["content"]).map((searchRaw) => {
					const searchItem = getObject(searchRaw);
					return result(
						getString(searchItem?.["title"]),
						getString(searchItem?.["url"]),
						getString(searchItem?.["page_age"]) ?? text,
					);
				});
			}),
		);
	}

	const output = getArray(data["output"]);
	const sources = collect(
		output.flatMap((raw) => {
			const item = getObject(raw);
			if (item?.["type"] !== "web_search_call") return [];
			const action = getObject(item["action"]);
			return getArray(action?.["sources"]).map((sourceRaw) => {
				const source = getObject(sourceRaw);
				const url = getString(source?.["url"]);
				return result(url, url);
			});
		}),
	);
	const message = output.map(getObject).find((item) => item?.["type"] === "message");
	const content = getArray(message?.["content"])
		.map(getObject)
		.find((item) => item?.["type"] === "output_text");
	const text = getString(content?.["text"]);
	const annotationResults = collect(
		getArray(content?.["annotations"]).map((raw) => {
			const item = getObject(raw);
			return item?.["type"] === "url_citation"
				? result(getString(item["title"]), getString(item["url"]), text)
				: null;
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
	if (provider !== "xai") return annotationResults;
	return collect(
		getArray(data["citations"]).map((raw) => {
			const url = getString(raw);
			return result(url, url, text);
		}),
	);
}
