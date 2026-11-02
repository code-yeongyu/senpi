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

const GOOGLE_HOME_URL = "https://www.google.com/";
const SNIPPET_SELECTORS = [".VwiC3b", ".IsZvec", ".BNeawe.s3v9rd", "[data-sncf='1']"];

/**
 * Google serves a script-only wall (`/httpservice/retry/enablejs`) to clients that do not run JavaScript,
 * an "unsupported browser" page to old user agents, and a `/sorry/` CAPTCHA to throttled ones.
 */
function detectGoogleChallenge(page: FetchedPage): string | undefined {
	if (page.url.includes("/sorry/") || /unusual traffic|g-recaptcha/i.test(page.body)) return "unusual-traffic CAPTCHA";
	if (/<h3\b/i.test(page.body)) return undefined;
	if (page.body.includes("/httpservice/retry/enablejs")) return "JavaScript wall";
	if (/browser isn.t supported anymore/i.test(page.body)) return "unsupported-browser page";
	return undefined;
}

function unwrapGoogleUrl(href: string | null | undefined): string | undefined {
	if (!href) return undefined;
	let url: URL;
	try {
		url = new URL(href, GOOGLE_HOME_URL);
	} catch {
		return undefined;
	}
	const target = url.pathname === "/url" ? (url.searchParams.get("q") ?? url.searchParams.get("url")) : url.href;
	return externalResultUrl(target, GOOGLE_HOME_URL, ["google.com"]);
}

function normalizeGoogleHtml(document: Document): SearchResultItem[] {
	const items: Array<SearchResultItem | null> = [];
	for (const heading of document.querySelectorAll("a h3")) {
		const container = heading.closest(".tF2Cxc, .MjjYud, .Gx5Zad");
		const snippet = SNIPPET_SELECTORS.map((selector) =>
			cleanText(container?.querySelector(selector)?.textContent),
		).find((text) => text !== undefined);
		items.push(
			result(cleanText(heading.textContent), unwrapGoogleUrl(heading.closest("a")?.getAttribute("href")), snippet),
		);
	}
	return uniqueByUrl(collect(items));
}

export const googleHtmlProvider: ProviderModule = {
	responseFormat: "html",
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const url = new URL(providerUrl(config));
		url.searchParams.set("q", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		url.searchParams.set("num", String(clamp(maxResults, 1, 20)));
		url.searchParams.set("hl", "en");
		url.searchParams.set("udm", "14");
		url.searchParams.set("pws", "0");
		return { url: url.toString(), init: { method: "GET", headers: browserHeaders(GOOGLE_HOME_URL) } };
	},
	detectChallenge: detectGoogleChallenge,
	normalizeDocument: normalizeGoogleHtml,
};
