import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type { SearchProvider, WebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

// Fixture in Synthetic's documented response shape (POST https://api.synthetic.new/v2/search), trimmed to
// the results array the parser reads. No test touches the network.
function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", name), "utf8");
}

function singleEngine(provider: SearchProvider, extra: Partial<WebsearchConfig["providers"][number]> = {}) {
	const config: WebsearchConfig = {
		strategy: "priority",
		fallback: true,
		auto: false,
		providers: [{ provider, ...extra }],
	};
	return config;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Synthetic provider", () => {
	it("requires an api key and accepts one", () => {
		const missing = validateProviderConfig({ provider: "synthetic" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toBe("missing_api_key");

		expect(validateProviderConfig({ provider: "synthetic", apiKey: "syn-test" }).ok).toBe(true);
	});

	it("posts the query with a bearer token and no upstream result-count field", () => {
		const allowed = buildSearchRequest(
			{ provider: "synthetic", apiKey: "syn-test" },
			{ query: "current docs", maxResults: 5, allowedDomains: ["docs.example.com"] },
		);

		expect(allowed.url).toBe("https://api.synthetic.new/v2/search");
		expect(allowed.init.method).toBe("POST");
		expect(allowed.init.headers.Authorization).toBe("Bearer syn-test");
		expect(allowed.init.headers["Content-Type"]).toBe("application/json");
		expect(allowed.body).toEqual({ query: "current docs site:docs.example.com" });

		const blocked = buildSearchRequest(
			{ provider: "synthetic", apiKey: "syn-test" },
			{ query: "current docs", maxResults: 5, blockedDomains: ["reddit.com"] },
		);
		expect(blocked.body).toEqual({ query: "current docs -site:reddit.com" });
	});

	it("sends the bare query when no domain filters are configured", () => {
		const request = buildSearchRequest(
			{ provider: "synthetic", apiKey: "syn-test" },
			{ query: "current docs", maxResults: 50 },
		);

		expect(request.body).toEqual({ query: "current docs" });
	});

	it("normalizes the recorded results payload", async () => {
		const payload: unknown = JSON.parse(fixture("synthetic-results.json"));
		const results = await normalizeSearchResponse("synthetic", payload);

		expect(results).toEqual([
			{
				title: "Documentation - TypeScript 4.9",
				url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
				snippet:
					"TypeScript 4.9 introduces the satisfies operator, which checks a value against a type without widening it.",
				publishedAt: "2024-11-20",
			},
			{
				title: "Everyday Types - TypeScript",
				url: "https://www.typescriptlang.org/docs/handbook/everyday-types.html",
				snippet:
					"TypeScript's type system works structurally; the satisfies keyword validates a value while keeping its narrowest inferred type.",
			},
			{
				title: "Expressions and operators - JavaScript | MDN",
				url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators",
			},
			{
				title: "https://example.com/guides/satisfies-operator",
				url: "https://example.com/guides/satisfies-operator",
			},
		]);
	});

	it("slices results to the requested maxResults locally", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(fixture("synthetic-results.json"), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
		);

		const details = await performSearch(singleEngine("synthetic", { apiKey: "syn-test" }), {
			query: "typescript satisfies operator",
			maxResults: 2,
		});

		expect(details.error).toBeUndefined();
		expect(details.provider).toBe("synthetic");
		expect(details.truncated).toBe(true);
		expect(details.results).toHaveLength(2);
		expect(details.results[0]?.url).toBe(
			"https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
		);
	});
});
