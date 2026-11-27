import { describe, expect, it } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";

// Ollama Cloud (https://ollama.com): POST /api/web_search with bearer auth,
// max_results clamped to 1..10. Ported from oh-my-pi's web search provider.
describe("vendored websearch ollama provider", () => {
	it("requires an api key and accepts one", () => {
		const missing = validateProviderConfig({ provider: "ollama" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toBe("missing_api_key");

		expect(validateProviderConfig({ provider: "ollama", apiKey: "ol-test" }).ok).toBe(true);
	});

	it("posts the query with bearer auth and clamps max_results to 1..10", () => {
		const request = buildSearchRequest(
			{ provider: "ollama", apiKey: "ol-test" },
			{ query: "current docs", maxResults: 5 },
		);

		expect(request.url).toBe("https://ollama.com/api/web_search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers.Authorization).toBe("Bearer ol-test");
		expect(request.body).toEqual({ query: "current docs", max_results: 5 });

		const capped = buildSearchRequest({ provider: "ollama", apiKey: "ol-test" }, { query: "q", maxResults: 500 });
		expect(capped.body).toEqual({ query: "q", max_results: 10 });

		const floored = buildSearchRequest({ provider: "ollama", apiKey: "ol-test" }, { query: "q", maxResults: 0 });
		expect(floored.body).toEqual({ query: "q", max_results: 1 });
	});

	it("honors a baseUrl override", () => {
		const proxied = buildSearchRequest(
			{ provider: "ollama", apiKey: "ol-test", baseUrl: "https://gateway.example.com/api/web_search" },
			{ query: "q", maxResults: 5 },
		);
		expect(proxied.url).toBe("https://gateway.example.com/api/web_search");
	});

	it("folds allowed and blocked domain filters into the query", () => {
		const allowed = buildSearchRequest(
			{ provider: "ollama", apiKey: "ol-test", allowedDomains: ["docs.example.com"] },
			{ query: "current docs", maxResults: 5 },
		);
		expect(allowed.body).toEqual({ query: "current docs site:docs.example.com", max_results: 5 });

		const blocked = buildSearchRequest(
			{ provider: "ollama", apiKey: "ol-test", blockedDomains: ["spam.example.com"] },
			{ query: "current docs", maxResults: 5 },
		);
		expect(blocked.body).toEqual({ query: "current docs -site:spam.example.com", max_results: 5 });
	});

	it("normalizes results[] with content as the snippet and the url as a missing title", async () => {
		const results = await normalizeSearchResponse("ollama", {
			results: [
				{ title: "Docs", url: "https://docs.example.com/page", content: "Ollama snippet" },
				{ url: "https://untitled.example.com" },
				{ title: "No url" },
				"junk",
			],
		});

		expect(results).toEqual([
			{ title: "Docs", url: "https://docs.example.com/page", snippet: "Ollama snippet" },
			{ title: "https://untitled.example.com", url: "https://untitled.example.com" },
		]);
	});
});
