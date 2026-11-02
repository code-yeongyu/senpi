import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.ts";
import type { BuildContext, FetchedPage, ProviderModule } from "./shared.ts";
import { appendDomainFilters, browserHeaders, collect, getString, result } from "./shared.ts";

function htmlDecode(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
		.replaceAll("&nbsp;", " ")
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

/**
 * DuckDuckGo answers throttled clients with an "anomaly" page instead of results, with status 200 or 202,
 * so the body is the only reliable signal.
 */
function detectDuckDuckGoChallenge(page: FetchedPage): string | undefined {
	return page.body.includes("anomaly-modal") || page.body.includes("anomaly.js") ? "anomaly page" : undefined;
}

export const duckDuckGoHtmlProvider: ProviderModule = {
	responseFormat: "html",
	// The no-JS frontend is a POST form; sending it the way its own form does keeps the request browser-shaped.
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const form = new URLSearchParams({
			q: appendDomainFilters(request.query, allowedDomains, blockedDomains),
			kl: "us-en",
			b: "",
		});
		return {
			url: providerUrl(config),
			init: {
				method: "POST",
				headers: browserHeaders("https://html.duckduckgo.com/", {
					"Content-Type": "application/x-www-form-urlencoded",
				}),
			},
			form: form.toString(),
		};
	},
	detectChallenge: detectDuckDuckGoChallenge,
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeDuckDuckGoHtml(getString(data.html) ?? "");
	},
};
