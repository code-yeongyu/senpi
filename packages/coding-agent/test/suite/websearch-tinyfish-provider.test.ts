import { afterEach, describe, expect, it, vi } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type { SearchRequest, WebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

// TinyFish: keyed GET https://api.search.tinyfish.ai with X-API-Key; at most ten results per page,
// paginated until the requested count is met, a page comes back short, or ten pages have been read.
// Ported from oh-my-pi's TinyFish adapter (senpi#5485). No live network: fetch is stubbed per test.
function singleEngine(maxResults?: number) {
	const config: WebsearchConfig = {
		strategy: "priority",
		fallback: true,
		auto: false,
		providers:
			maxResults === undefined
				? [{ provider: "tinyfish", apiKey: "tf-test" }]
				: [{ provider: "tinyfish", apiKey: "tf-test", maxResults }],
	};
	return config;
}

const REQUEST: SearchRequest = { query: "typescript satisfies operator", maxResults: 15 };

describe("vendored websearch tinyfish provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("requires an api key and accepts one", () => {
		const missing = validateProviderConfig({ provider: "tinyfish" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toBe("missing_api_key");

		expect(validateProviderConfig({ provider: "tinyfish", apiKey: "tf-test" }).ok).toBe(true);
	});

	it("sends a keyed GET with the query, per-page count and page 0", () => {
		const request = buildSearchRequest(
			{ provider: "tinyfish", apiKey: "tf-test" },
			{ query: "current docs", maxResults: 5 },
		);
		const url = new URL(request.url);

		expect(url.origin + url.pathname).toBe("https://api.search.tinyfish.ai/");
		expect(url.searchParams.get("query")).toBe("current docs");
		expect(url.searchParams.get("num_results")).toBe("5");
		expect(url.searchParams.get("page")).toBe("0");
		expect(request.init.method).toBe("GET");
		expect(request.init.headers["X-API-Key"]).toBe("tf-test");
		expect(request.init.headers.Accept).toBe("application/json");
		expect(request.body).toBeUndefined();
	});

	it("clamps the count into 1..20 and requests at most ten results per page", () => {
		const tiny = new URL(
			buildSearchRequest({ provider: "tinyfish", apiKey: "tf-test" }, { query: "q", maxResults: 0 }).url,
		);
		expect(tiny.searchParams.get("num_results")).toBe("1");

		const huge = new URL(
			buildSearchRequest({ provider: "tinyfish", apiKey: "tf-test" }, { query: "q", maxResults: 500 }).url,
		);
		expect(huge.searchParams.get("num_results")).toBe("10");
	});

	it("maps domain filters to the native include and exclude params", () => {
		const allowed = new URL(
			buildSearchRequest(
				{ provider: "tinyfish", apiKey: "tf-test", allowedDomains: ["docs.example.com"] },
				{ query: "current docs", maxResults: 5 },
			).url,
		);
		expect(allowed.searchParams.get("include_domains")).toBe("docs.example.com");
		expect(allowed.searchParams.get("exclude_domains")).toBeNull();

		const blocked = new URL(
			buildSearchRequest(
				{ provider: "tinyfish", apiKey: "tf-test", blockedDomains: ["spam.example.com"] },
				{ query: "current docs", maxResults: 5 },
			).url,
		);
		expect(blocked.searchParams.get("exclude_domains")).toBe("spam.example.com");
		expect(blocked.searchParams.get("include_domains")).toBeNull();
	});

	it("honors a baseUrl override", () => {
		const request = buildSearchRequest(
			{ provider: "tinyfish", apiKey: "tf-test", baseUrl: "https://search-gateway.example.com/search" },
			{ query: "q", maxResults: 5 },
		);

		expect(new URL(request.url).origin + new URL(request.url).pathname).toBe(
			"https://search-gateway.example.com/search",
		);
	});

	it("normalizes results with site_name fallback and drops url-less entries", async () => {
		const results = await normalizeSearchResponse("tinyfish", {
			results: [
				{ title: "Docs", url: "https://docs.example.com/page", snippet: "  TinyFish   snippet  " },
				{ site_name: "Example Site", url: "https://site.example.com" },
				{ title: "No url" },
			],
		});

		expect(results).toEqual([
			{ title: "Docs", url: "https://docs.example.com/page", snippet: "TinyFish snippet" },
			{ title: "Example Site", url: "https://site.example.com" },
		]);
	});

	it("paginates until the count is met and stops at a short page", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				const page = Number(url.searchParams.get("page"));
				calls.push(`${page}#num=${url.searchParams.get("num_results")}`);
				const count = page === 0 ? 10 : 5;
				return Response.json({
					page,
					results: Array.from({ length: count }, (_value, index) => ({
						title: `R${page}-${index}`,
						url: `https://example.com/${page}/${index}`,
					})),
				});
			}),
		);

		const details = await performSearch(singleEngine(), REQUEST);

		expect(calls).toEqual(["0#num=10", "1#num=10"]);
		expect(details.error).toBeUndefined();
		expect(details.results.length).toBe(15);
		expect(details.results[0]?.url).toBe("https://example.com/0/0");
		expect(details.results[14]?.url).toBe("https://example.com/1/4");
	});

	it("keeps the first occurrence of a URL across pages and stops when the count is met", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const page = Number(new URL(String(input)).searchParams.get("page"));
			const results =
				page === 0
					? Array.from({ length: 10 }, (_value, index) => ({
							title: `A${index}`,
							url: `https://example.com/${index}`,
						}))
					: [
							{ title: "duplicate of page 0", url: "https://example.com/0" },
							...Array.from({ length: 9 }, (_value, index) => ({
								title: `B${index}`,
								url: `https://example.com/1${index}`,
							})),
						];
			return Response.json({ page, results });
		});
		vi.stubGlobal("fetch", fetchMock);

		const details = await performSearch(singleEngine(), REQUEST);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(details.results.length).toBe(15);
		const urls = details.results.map((item) => item.url);
		expect(new Set(urls).size).toBe(urls.length);
	});

	it("stops after ten pages when every page is full but duplicates keep the count short", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const page = Number(new URL(String(input)).searchParams.get("page"));
			return Response.json({
				page,
				results: Array.from({ length: 10 }, (_value, index) => ({
					title: `R${index}`,
					url: `https://example.com/${index}`,
				})),
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const details = await performSearch(singleEngine(), { query: "q", maxResults: 20 });

		expect(fetchMock).toHaveBeenCalledTimes(10);
		expect(details.results.length).toBe(10);
	});

	it("fails the search when a later page returns an HTTP error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const page = Number(new URL(String(input)).searchParams.get("page"));
				if (page === 0) {
					return Response.json({
						results: Array.from({ length: 10 }, (_value, index) => ({
							title: `R${index}`,
							url: `https://example.com/${index}`,
						})),
					});
				}
				return new Response("rate limited", { status: 429, headers: { "Retry-After": "7" } });
			}),
		);

		const details = await performSearch(singleEngine(), REQUEST);

		expect(details.error).toContain("HTTP 429");
		expect(details.blocked).toBe("rate_limited");
		expect(details.retryAfterSeconds).toBe(7);
	});
});
