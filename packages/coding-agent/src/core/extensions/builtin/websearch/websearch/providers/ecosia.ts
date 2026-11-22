import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, SearchResultItem } from "../types.ts";
import type { BuildContext, FetchedPage, ProviderModule } from "./shared.ts";
import {
	appendDomainFilters,
	browserHeaders,
	cleanText,
	collect,
	externalResultUrl,
	result,
	uniqueByUrl,
} from "./shared.ts";

const ECOSIA_HOME_URL = "https://www.ecosia.org/";

/** Ecosia's firewall serves a managed challenge (usually HTTP 403) titled "Ecosia Firewall". */
function detectEcosiaChallenge(page: FetchedPage): string | undefined {
	return page.body.includes("Ecosia Firewall") ||
		page.body.includes("_cf_chl_opt") ||
		page.body.includes("/cdn-cgi/challenge-platform/")
		? "firewall challenge"
		: undefined;
}

function normalizeEcosiaHtml(document: Document): SearchResultItem[] {
	const items: Array<SearchResultItem | null> = [];
	for (const article of document.querySelectorAll('article[data-test-id="organic-result"]')) {
		const heading = article.querySelector('[data-test-id="result-title"]');
		const url = externalResultUrl(heading?.closest("a")?.getAttribute("href"), ECOSIA_HOME_URL, ["ecosia.org"]);
		const description =
			article.querySelector('[data-test-id="web-result-description"]') ??
			article.querySelector('[data-test-id="result-description"]');
		items.push(result(cleanText(heading?.textContent), url, cleanText(description?.textContent)));
	}
	return uniqueByUrl(collect(items));
}

export const ecosiaProvider: ProviderModule = {
	responseFormat: "html",
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const url = new URL(providerUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		return { url: url.toString(), init: { method: "GET", headers: browserHeaders(ECOSIA_HOME_URL) } };
	},
	detectChallenge: detectEcosiaChallenge,
	normalizeDocument: normalizeEcosiaHtml,
};
