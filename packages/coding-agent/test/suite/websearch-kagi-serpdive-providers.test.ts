import { describe, expect, it } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";
import type { SearchProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

// Ported from pi-websearch 0.4.0 (Kagi: code-yeongyu/pi-websearch#9, SERPdive: code-yeongyu/pi-websearch#7).
describe("vendored websearch kagi provider", () => {
	it("requires an api key and accepts one", () => {
		const missing = validateProviderConfig({ provider: "kagi" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toBe("missing_api_key");

		expect(validateProviderConfig({ provider: "kagi", apiKey: "kagi-test" }).ok).toBe(true);
	});

	it("posts the query with lens domain filters, request filters narrowing config filters", () => {
		const config: SearchProviderConfig = {
			provider: "kagi",
			apiKey: "kagi-test",
			allowedDomains: ["docs.example.com", "api.example.com"],
		};

		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["api.example.com"],
		});

		expect(request.url).toBe("https://kagi.com/api/v1/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers.Authorization).toBe("Bearer kagi-test");
		expect(request.body).toEqual({
			query: "current docs",
			limit: 5,
			lens: { sites_included: ["api.example.com"] },
		});
	});

	it("maps a blocklist into lens exclusions and omits lens without filters", () => {
		const blocked = buildSearchRequest(
			{ provider: "kagi", apiKey: "kagi-test", blockedDomains: ["spam.example.com"] },
			{ query: "current docs", maxResults: 5 },
		);
		expect(blocked.body).toEqual({
			query: "current docs",
			limit: 5,
			lens: { sites_excluded: ["spam.example.com"] },
		});

		const plain = buildSearchRequest(
			{ provider: "kagi", apiKey: "kagi-test" },
			{ query: "current docs", maxResults: 30 },
		);
		expect(plain.body).toEqual({ query: "current docs", limit: 20 });
	});

	it("normalizes data.search results with publishedAt", async () => {
		const results = await normalizeSearchResponse("kagi", {
			meta: { ms: 42 },
			data: {
				search: [
					{
						title: "Kagi Result",
						url: "https://kagi.example.com",
						snippet: "Kagi snippet",
						time: "2026-01-01T00:00:00Z",
					},
				],
			},
		});

		expect(results).toEqual([
			{
				title: "Kagi Result",
				url: "https://kagi.example.com",
				snippet: "Kagi snippet",
				publishedAt: "2026-01-01T00:00:00Z",
			},
		]);
	});
});

describe("vendored websearch serpdive provider", () => {
	it("requires an api key", () => {
		const missing = validateProviderConfig({ provider: "serpdive" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toBe("missing_api_key");
	});

	it("sends a bearer token, caps results at 10 and folds domain filters into the query", () => {
		const request = buildSearchRequest(
			{ provider: "serpdive", apiKey: "sd-test" },
			{
				query: "current docs",
				maxResults: 20,
				allowedDomains: ["docs.example.com"],
				blockedDomains: ["reddit.com"],
			},
		);

		expect(request.url).toBe("https://api.serpdive.com/v1/search");
		expect(request.init.headers.Authorization).toBe("Bearer sd-test");
		expect(request.body).toEqual({ query: "current docs site:docs.example.com", max_results: 10 });
	});

	it("normalizes results[].content into the snippet", async () => {
		const results = await normalizeSearchResponse("serpdive", {
			results: [
				{ title: "Docs", url: "https://docs.example.com", content: "Extracted page content", date: "2026-06-19" },
			],
			response_time_ms: 1400,
		});

		expect(results).toEqual([{ title: "Docs", url: "https://docs.example.com", snippet: "Extracted page content" }]);
	});
});
