import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
	searchResponseError,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";

// Ported from oh-my-pi's web/search/providers/firecrawl.ts. The fixture follows the documented
// `/v2/search` response shape with synthetic values, so this test never touches the network.
function fixture(): unknown {
	return JSON.parse(
		readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", "firecrawl-search-results.json"), "utf8"),
	);
}

describe("vendored websearch firecrawl provider", () => {
	it("is keyless-capable and also accepts an api key", () => {
		expect(validateProviderConfig({ provider: "firecrawl" }).ok).toBe(true);
		expect(validateProviderConfig({ provider: "firecrawl", apiKey: "fc-test" }).ok).toBe(true);
	});

	it("posts a web-sources search without a credential when no apiKey is configured", () => {
		const request = buildSearchRequest({ provider: "firecrawl" }, { query: "current docs", maxResults: 5 });

		expect(request.url).toBe("https://api.firecrawl.dev/v2/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers["Content-Type"]).toBe("application/json");
		expect(request.init.headers.Authorization).toBeUndefined();
		expect(request.body).toEqual({ query: "current docs", limit: 5, sources: [{ type: "web" }] });
	});

	it("sends the api key as a bearer token when one is configured", () => {
		const request = buildSearchRequest(
			{ provider: "firecrawl", apiKey: "fc-test" },
			{ query: "current docs", maxResults: 5 },
		);

		expect(request.init.headers.Authorization).toBe("Bearer fc-test");
		expect(request.body).toEqual({ query: "current docs", limit: 5, sources: [{ type: "web" }] });
	});

	it("clamps the result count to 1-100", () => {
		const capped = buildSearchRequest({ provider: "firecrawl" }, { query: "q", maxResults: 500 });
		expect(capped.body).toEqual({ query: "q", limit: 100, sources: [{ type: "web" }] });

		const floored = buildSearchRequest({ provider: "firecrawl" }, { query: "q", maxResults: 0 });
		expect(floored.body).toEqual({ query: "q", limit: 1, sources: [{ type: "web" }] });
	});

	it("folds domain filters into the query", () => {
		const allowed = buildSearchRequest(
			{ provider: "firecrawl" },
			{ query: "current docs", maxResults: 5, allowedDomains: ["docs.example.com"] },
		);
		expect(allowed.body).toEqual({
			query: "current docs site:docs.example.com",
			limit: 5,
			sources: [{ type: "web" }],
		});

		const blocked = buildSearchRequest(
			{ provider: "firecrawl", blockedDomains: ["spam.example.com"] },
			{ query: "current docs", maxResults: 5 },
		);
		expect(blocked.body).toEqual({
			query: "current docs -site:spam.example.com",
			limit: 5,
			sources: [{ type: "web" }],
		});
	});

	it("honors a public https baseUrl and refuses a credential-bearing or plaintext one", () => {
		const proxied = buildSearchRequest(
			{ provider: "firecrawl", baseUrl: "https://search-gateway.example.com/v2/search" },
			{ query: "q", maxResults: 5 },
		);

		expect(proxied.url).toBe("https://search-gateway.example.com/v2/search");
		expect(
			validateProviderConfig({ provider: "firecrawl", baseUrl: "https://search-gateway.example.com/v2/search" }).ok,
		).toBe(true);

		const plaintext = validateProviderConfig({ provider: "firecrawl", baseUrl: "http://localhost:3002/v2/search" });
		expect(plaintext.ok).toBe(false);
		if (!plaintext.ok) expect(plaintext.reason).toBe("invalid_config");
	});

	it("normalizes the recorded v2 response", async () => {
		const results = await normalizeSearchResponse("firecrawl", fixture());

		expect(results).toEqual([
			{
				title: "TypeScript 4.9 Release Notes",
				url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
				snippet: "The satisfies operator validates an expression against a type without widening it.",
			},
			{
				title: "Satisfies operator reference",
				url: "https://developer.example.com/typescript/satisfies",
				snippet: "Snippet-shaped result without a description.",
			},
			{
				title: "Recorded markdown-only result",
				url: "https://blog.example.com/satisfies-walkthrough",
				snippet: "# Walkthrough\n\nA markdown body stands in for the snippet when no description is returned.",
			},
			{
				title: "https://untitled.example.com/satisfies",
				url: "https://untitled.example.com/satisfies",
				snippet: "A result without a title keeps its URL as the title.",
			},
		]);
	});

	it("reads a flat data array and a legacy results array", async () => {
		const flat = await normalizeSearchResponse("firecrawl", {
			data: [{ title: "Flat", url: "https://flat.example.com", description: "Flat data array" }],
		});
		expect(flat).toEqual([{ title: "Flat", url: "https://flat.example.com", snippet: "Flat data array" }]);

		const legacy = await normalizeSearchResponse("firecrawl", {
			results: [{ title: "Legacy", url: "https://legacy.example.com" }],
		});
		expect(legacy).toEqual([{ title: "Legacy", url: "https://legacy.example.com" }]);
	});

	it("reports the error carried inside a success:false payload", () => {
		expect(searchResponseError("firecrawl", { success: false, error: "Invalid API key" })).toBe("Invalid API key");
		expect(searchResponseError("firecrawl", { success: true, id: "fc-search-fixture-0001" })).toBeUndefined();
	});
});
