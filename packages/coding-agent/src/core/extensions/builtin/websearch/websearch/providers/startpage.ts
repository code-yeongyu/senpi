import { parseHtmlDocument } from "../html-document.lazy.ts";
import { providerUrl } from "../provider-endpoints.ts";
import type { BuiltSearchRequest, SearchResultItem } from "../types.ts";
import type { BuildContext, FetchedPage, PageFetcher, ProviderModule } from "./shared.ts";
import {
	appendDomainFilters,
	browserHeaders,
	cleanText,
	collect,
	externalResultUrl,
	result,
	uniqueByUrl,
} from "./shared.ts";

const STARTPAGE_HOME_URL = "https://www.startpage.com/";

/**
 * Startpage fronts its pages with a proof-of-work interstitial (Anubis) for clients it does not trust, and
 * redirects a search without a fresh form token to a CAPTCHA shell. Both need a browser to pass.
 */
function detectStartpageChallenge(page: FetchedPage): string | undefined {
	if (page.body.includes('id="anubis_challenge"') || page.body.includes("anubis_version")) {
		return "proof-of-work interstitial";
	}
	if (
		/\/(?:errors|captcha)\//.test(page.url) ||
		page.body.includes("component---src-pages-captcha") ||
		page.body.includes("/sp/captcha")
	) {
		return "CAPTCHA page";
	}
	return undefined;
}

async function searchFormInputs(html: string): Promise<Record<string, string> | undefined> {
	const document = await parseHtmlDocument(html);
	const form = document.querySelector('form[action="/sp/search"]');
	if (!form) return undefined;
	const inputs: Record<string, string> = {};
	for (const input of form.querySelectorAll('input[type="hidden"]')) {
		const name = input.getAttribute("name");
		if (name) inputs[name] = input.getAttribute("value") ?? "";
	}
	return inputs.sc ? inputs : undefined;
}

function normalizeStartpageHtml(document: Document): SearchResultItem[] {
	const items: Array<SearchResultItem | null> = [];
	for (const block of document.querySelectorAll("div.result")) {
		const anchor = block.querySelector("a.result-link");
		const url = externalResultUrl(anchor?.getAttribute("href"), STARTPAGE_HOME_URL, ["startpage.com"]);
		const title = cleanText(anchor?.querySelector("h2, h3")?.textContent ?? anchor?.textContent);
		items.push(result(title, url, cleanText(block.querySelector("p.description")?.textContent)));
	}
	return uniqueByUrl(collect(items));
}

export const startpageProvider: ProviderModule = {
	responseFormat: "html",
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const url = new URL(providerUrl(config));
		url.searchParams.set("query", appendDomainFilters(request.query, allowedDomains, blockedDomains));
		return { url: url.toString(), init: { method: "GET", headers: browserHeaders(STARTPAGE_HOME_URL) } };
	},
	// A browser opens the homepage first and posts its search form with the session token; do the same.
	async prepareRequest(
		ctx: BuildContext,
		built: BuiltSearchRequest,
		fetchPage: PageFetcher,
	): Promise<BuiltSearchRequest | { challenge: string }> {
		const home = await fetchPage({ url: STARTPAGE_HOME_URL, init: { method: "GET", headers: browserHeaders() } });
		const challenge = detectStartpageChallenge(home);
		if (challenge) return { challenge };
		const inputs = home.status >= 200 && home.status < 300 ? await searchFormInputs(home.body) : undefined;
		if (!inputs) return built;
		const form = new URLSearchParams(inputs);
		form.set("query", appendDomainFilters(ctx.request.query, ctx.allowedDomains, ctx.blockedDomains));
		return {
			url: providerUrl(ctx.config),
			init: {
				method: "POST",
				headers: browserHeaders(STARTPAGE_HOME_URL, { "Content-Type": "application/x-www-form-urlencoded" }),
			},
			form: form.toString(),
		};
	},
	detectChallenge: detectStartpageChallenge,
	normalizeDocument: normalizeStartpageHtml,
};
