import { describe, expect, it } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";

// Keenable (https://keenable.ai): keyed POST /v1/search with X-API-Key, keyless
// POST /v1/search/public identified by X-Keenable-Title.
describe("vendored websearch keenable provider", () => {
	it("is keyless-capable and also accepts an api key", () => {
		expect(validateProviderConfig({ provider: "keenable" }).ok).toBe(true);
		expect(validateProviderConfig({ provider: "keenable", apiKey: "kn-test" }).ok).toBe(true);
	});

	it("posts to the keyed endpoint with X-API-Key when an apiKey is configured", () => {
		const request = buildSearchRequest(
			{ provider: "keenable", apiKey: "kn-test" },
			{ query: "current docs", maxResults: 5 },
		);

		expect(request.url).toBe("https://api.keenable.ai/v1/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers["X-API-Key"]).toBe("kn-test");
		expect(request.init.headers["X-Keenable-Title"]).toBeUndefined();
		expect(request.body).toEqual({ query: "current docs", max_results: 5 });
	});

	it("posts to the public endpoint with an app title when no apiKey is configured", () => {
		const request = buildSearchRequest({ provider: "keenable" }, { query: "current docs", maxResults: 5 });

		expect(request.url).toBe("https://api.keenable.ai/v1/search/public");
		expect(request.init.headers["X-API-Key"]).toBeUndefined();
		expect(typeof request.init.headers["X-Keenable-Title"]).toBe("string");
		expect(request.init.headers["X-Keenable-Title"]?.length).toBeGreaterThan(0);
	});

	it("caps max_results at 50 and honors a baseUrl override", () => {
		const capped = buildSearchRequest({ provider: "keenable", apiKey: "kn-test" }, { query: "q", maxResults: 500 });
		expect(capped.body).toEqual({ query: "q", max_results: 50 });

		const proxied = buildSearchRequest(
			{ provider: "keenable", baseUrl: "https://search-gateway.example.com/v1/search" },
			{ query: "q", maxResults: 5 },
		);
		expect(proxied.url).toBe("https://search-gateway.example.com/v1/search");
		expect(proxied.init.headers["X-Keenable-Title"]).toBeDefined();
	});

	it("maps a lone allowed domain to the native site field and folds the rest into the query", () => {
		const single = buildSearchRequest(
			{ provider: "keenable", apiKey: "kn-test", allowedDomains: ["docs.example.com"] },
			{ query: "current docs", maxResults: 5 },
		);
		expect(single.body).toEqual({ query: "current docs", max_results: 5, site: "docs.example.com" });

		const multiple = buildSearchRequest(
			{ provider: "keenable", apiKey: "kn-test", allowedDomains: ["a.example.com", "b.example.com"] },
			{ query: "current docs", maxResults: 5 },
		);
		expect(multiple.body).toEqual({
			query: "current docs site:a.example.com site:b.example.com",
			max_results: 5,
		});

		const blocked = buildSearchRequest(
			{ provider: "keenable", apiKey: "kn-test", blockedDomains: ["spam.example.com"] },
			{ query: "current docs", maxResults: 5 },
		);
		expect(blocked.body).toEqual({ query: "current docs -site:spam.example.com", max_results: 5 });
	});

	it("normalizes results with snippet fallback and publishedAt", async () => {
		const results = await normalizeSearchResponse("keenable", {
			query: "current docs",
			results: [
				{
					title: "Docs",
					url: "https://docs.example.com/page",
					snippet: "Keenable snippet",
					published_at: "2026-01-01T00:00:00Z",
				},
				{ title: "Described", url: "https://desc.example.com", description: "Description text" },
				{ url: "https://untitled.example.com" },
				{ title: "Bad scheme", url: "javascript:alert(1)" },
				{ title: "No url" },
			],
		});

		expect(results).toEqual([
			{
				title: "Docs",
				url: "https://docs.example.com/page",
				snippet: "Keenable snippet",
				publishedAt: "2026-01-01T00:00:00Z",
			},
			{ title: "Described", url: "https://desc.example.com/", snippet: "Description text" },
			{ title: "https://untitled.example.com/", url: "https://untitled.example.com/" },
		]);
	});
});
