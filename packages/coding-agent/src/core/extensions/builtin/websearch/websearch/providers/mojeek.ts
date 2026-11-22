import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, SearchResultItem } from "../types.ts";
import type { BuildContext, FetchedPage, ProviderModule } from "./shared.ts";
import {
	appendDomainFilters,
	browserHeaders,
	clamp,
	cleanText,
	collect,
	externalResultUrl,
	result,
	uniqueByUrl,
} from "./shared.ts";

const MOJEEK_HOME_URL = "https://www.mojeek.com/";
const MOJEEK_HOSTS = ["mojeek.com", "mojeek.co.uk", "mojeek.de", "mojeek.fr"];

/** Mojeek answers scripted clients with an ALTCHA proof-of-work page (200) or an "automated queries" refusal (403). */
function detectMojeekChallenge(page: FetchedPage): string | undefined {
	if (page.body.includes("results-standard")) return undefined;
	if (page.body.includes("captcha-wrap") || page.body.includes("altcha")) return "ALTCHA verification page";
	if (/sending automated queries/i.test(page.body)) return "automated-queries refusal";
	return undefined;
}

function normalizeMojeekHtml(document: Document): SearchResultItem[] {
	const items: Array<SearchResultItem | null> = [];
	for (const row of document.querySelectorAll("ul.results-standard > li")) {
		const anchor = row.querySelector("h2 a.title") ?? row.querySelector("a.title");
		const url = externalResultUrl(anchor?.getAttribute("href"), MOJEEK_HOME_URL, MOJEEK_HOSTS);
		items.push(result(cleanText(anchor?.textContent), url, cleanText(row.querySelector("p.s")?.textContent)));
	}
	return uniqueByUrl(collect(items));
}

export const mojeekProvider: ProviderModule = {
	responseFormat: "html",
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const url = new URL(providerUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		url.searchParams.set("t", String(clamp(maxResults, 1, 20)));
		return { url: url.toString(), init: { method: "GET", headers: browserHeaders(MOJEEK_HOME_URL) } };
	},
	detectChallenge: detectMojeekChallenge,
	normalizeDocument: normalizeMojeekHtml,
};
