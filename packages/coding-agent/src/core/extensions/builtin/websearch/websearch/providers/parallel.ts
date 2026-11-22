import { defaultProviderUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, JsonValue, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import {
	appendDomainFilters,
	collect,
	contentHeaders,
	getArray,
	getObject,
	getString,
	result,
	uniqueByUrl,
} from "./shared.ts";

/** Parallel gates its Search API behind a dated beta channel; the keyless MCP endpoint takes no such header. */
const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";
const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1beta/search";
const MAX_EXCERPT_CHARS = 10_000;
const MAX_SNIPPET_CHARS = 400;

function hasApiKey({ config }: BuildContext): boolean {
	return typeof config.apiKey === "string" && config.apiKey.length > 0;
}

/** Parallel ignores `exclude_domains` whenever `include_domains` is set, so exclusions are only sent without one. */
function sourcePolicy(allowedDomains?: string[], blockedDomains?: string[]): JsonObject | undefined {
	if (allowedDomains && allowedDomains.length > 0) return { include_domains: allowedDomains };
	if (blockedDomains && blockedDomains.length > 0) return { exclude_domains: blockedDomains };
	return undefined;
}

/** Keyless: the public MCP server, called over JSON-RPC. No session id or model id leaves this request. */
function mcpRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
	return {
		url: config.baseUrl ?? defaultProviderUrl("parallel"),
		init: {
			method: "POST",
			headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
		},
		body: {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search",
				arguments: {
					objective: request.query,
					search_queries: [appendDomainFilters(request.query, allowedDomains, blockedDomains)],
				},
			},
		},
	};
}

function keyedRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
	const body: JsonObject = {
		objective: request.query,
		search_queries: [request.query],
		mode: "fast",
		excerpts: { max_chars_per_result: MAX_EXCERPT_CHARS },
	};
	const policy = sourcePolicy(allowedDomains, blockedDomains);
	if (policy) body.source_policy = policy;
	return {
		url: config.baseUrl ?? PARALLEL_SEARCH_URL,
		init: {
			method: "POST",
			headers: contentHeaders({ "x-api-key": config.apiKey ?? "", "parallel-beta": PARALLEL_BETA_HEADER }),
		},
		body,
	};
}

/**
 * The search payload is at the top level for the keyed API, and nested inside the JSON-RPC result for
 * MCP: `structuredContent` when the server fills it, otherwise the JSON text of a `content` part.
 */
function searchPayload(data: JsonObject): JsonObject {
	const toolResult = getObject(data.result);
	if (!toolResult) return data;
	const structured = getObject(toolResult.structuredContent);
	if (structured) return structured;
	for (const part of getArray(toolResult.content)) {
		const text = getString(getObject(part)?.text);
		if (!text || !text.trimStart().startsWith("{")) continue;
		try {
			const parsed: JsonValue = JSON.parse(text);
			const payload = getObject(parsed);
			if (payload) return payload;
		} catch {
			continue;
		}
	}
	return {};
}

function snippetOf(excerpts: JsonValue[]): string | undefined {
	const text = excerpts
		.map((excerpt) => (typeof excerpt === "string" ? excerpt.replace(/\s+/g, " ").trim() : ""))
		.filter((excerpt) => excerpt.length > 0)
		.join(" ");
	if (text.length === 0) return undefined;
	return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS - 1)}…` : text;
}

function normalizeParallelResult(data: JsonObject): SearchResultItem[] {
	return uniqueByUrl(
		collect(
			getArray(searchPayload(data).results).map((raw) => {
				const item = getObject(raw);
				const url = getString(item?.url);
				if (!item || !url) return null;
				const normalized = result(getString(item.title) ?? url, url, snippetOf(getArray(item.excerpts)));
				const published = getString(item.publish_date);
				if (normalized && published) normalized.publishedAt = published;
				return normalized;
			}),
		),
	);
}

function parallelError(data: JsonObject): string | undefined {
	const rpcError = getString(getObject(data.error)?.message);
	if (rpcError) return `Parallel MCP error: ${rpcError}`;
	const toolResult = getObject(data.result);
	if (toolResult?.isError !== true) return undefined;
	const message = getArray(toolResult.content)
		.map((part) => getString(getObject(part)?.text) ?? "")
		.join(" ")
		.trim();
	return `Parallel search error: ${message || "the search tool reported an error"}`;
}

export const parallelProvider: ProviderModule = {
	// Both paths answer with JSON; MCP may stream it as server-sent events.
	responseFormat: "event-stream",
	buildRequest(ctx: BuildContext): BuiltSearchRequest {
		return hasApiKey(ctx) ? keyedRequest(ctx) : mcpRequest(ctx);
	},
	responseError: parallelError,
	normalizeResponse: normalizeParallelResult,
};
