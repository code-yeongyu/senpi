import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, ProviderModule } from "./shared.ts";
import { appendDomainFilters, collect, getString, result } from "./shared.ts";

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

export const duckDuckGoHtmlProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const url = new URL(providerUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		return { url: url.toString(), init: { method: "GET", headers: { Accept: "text/html" } } };
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeDuckDuckGoHtml(getString(data.html) ?? "");
	},
};
