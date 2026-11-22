import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { appendDomainFilters, clamp, collect, getArray, getObject, getString, result, uniqueByUrl } from "./shared.ts";

const MAX_SNIPPET_CHARS = 400;

function field(section: string, name: string): string | undefined {
	const value = new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(section)?.[1]?.trim();
	return value && value !== "N/A" ? value : undefined;
}

function snippetOf(section: string): string | undefined {
	const match = /^(?:Highlights|Text|Summary):[ \t]*\n?([\s\S]*)$/m.exec(section);
	const text = match?.[1]?.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS - 1)}…` : text;
}

/** Each search hit is a `Title:` / `URL:` / `Published:` / `Highlights:` section in the tool's text content. */
function normalizeExaMcpResult(data: JsonObject): SearchResultItem[] {
	const text = getArray(getObject(data.result)?.content)
		.map((part) => getString(getObject(part)?.text) ?? "")
		.join("\n\n")
		.replace(/\r\n?/g, "\n");
	const sections = text.split(/\n{2,}(?=Title:)/).filter((section) => section.startsWith("Title:"));
	return uniqueByUrl(
		collect(
			sections.map((section) => {
				const item = result(field(section, "Title"), field(section, "URL"), snippetOf(section));
				const published = field(section, "Published") ?? field(section, "Published Date");
				if (item && published) item.publishedAt = published;
				return item;
			}),
		),
	);
}

function exaMcpError(data: JsonObject): string | undefined {
	const rpcError = getString(getObject(data.error)?.message);
	if (rpcError) return `Exa MCP error: ${rpcError}`;
	const toolResult = getObject(data.result);
	if (toolResult?.isError !== true) return undefined;
	const message = getArray(toolResult.content)
		.map((part) => getString(getObject(part)?.text) ?? "")
		.join(" ")
		.trim();
	return `Exa MCP error: ${message || "the search tool reported an error"}`;
}

export const exaMcpProvider: ProviderModule = {
	responseFormat: "event-stream",
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const url = new URL(providerUrl(config));
		url.searchParams.set("tools", "web_search_exa");
		return {
			url: url.toString(),
			init: {
				method: "POST",
				headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
			},
			body: {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "web_search_exa",
					arguments: {
						query: appendDomainFilters(request.query, allowedDomains, blockedDomains),
						numResults: clamp(maxResults, 1, 20),
					},
				},
			},
		};
	},
	responseError: exaMcpError,
	normalizeResponse: normalizeExaMcpResult,
};
