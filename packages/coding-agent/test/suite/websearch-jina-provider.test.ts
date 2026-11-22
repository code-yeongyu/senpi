import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type { WebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

// Jina Reader search (s.jina.ai): the query travels in the URL path, count is clamped to 1..20, the
// key is a bearer token, X-Respond-With keeps page text out of the answer, and a lone allowed domain
// is sent as Jina's host-only X-Site filter.
function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", name), "utf8");
}

const REQUEST = { query: "typescript satisfies operator", maxResults: 5 };
const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; headers: Headers }> = [];

function jinaConfig(extra: Partial<WebsearchConfig["providers"][number]> = {}): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: false,
		auto: false,
		providers: [{ provider: "jina", apiKey: "jina-test", ...extra }],
	};
}

/** Answers every search with one canned body and records what the provider actually sent. */
function stubFetch(handler: (url: string) => Response): void {
	fetchCalls = [];
	const stub: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		fetchCalls.push({ url, headers: new Headers(init?.headers) });
		return handler(url);
	};
	globalThis.fetch = stub;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	fetchCalls = [];
});

describe("vendored websearch jina provider", () => {
	it("requires an api key and accepts one", () => {
		const missing = validateProviderConfig({ provider: "jina" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.reason).toBe("missing_api_key");

		expect(validateProviderConfig({ provider: "jina", apiKey: "jina-test" }).ok).toBe(true);
	});

	it("puts the encoded query in the path and clamps count to 1..20", () => {
		const built = buildSearchRequest({ provider: "jina", apiKey: "jina-test" }, REQUEST);
		expect(built.init.method).toBe("GET");
		expect(built.url).toBe("https://s.jina.ai/typescript%20satisfies%20operator?count=5");

		const capped = buildSearchRequest({ provider: "jina", apiKey: "jina-test" }, { ...REQUEST, maxResults: 500 });
		expect(capped.url).toBe("https://s.jina.ai/typescript%20satisfies%20operator?count=20");

		const floored = buildSearchRequest({ provider: "jina", apiKey: "jina-test" }, { ...REQUEST, maxResults: 0 });
		expect(floored.url).toBe("https://s.jina.ai/typescript%20satisfies%20operator?count=1");
	});

	it("sends the key as a bearer token with the no-content headers", () => {
		const built = buildSearchRequest({ provider: "jina", apiKey: "jina-test" }, REQUEST);
		expect(built.init.headers).toEqual({
			Accept: "application/json",
			Authorization: "Bearer jina-test",
			"X-Respond-With": "no-content",
			"X-Retain-Images": "none",
		});
		expect(built.body).toBeUndefined();
	});

	it("maps one allowed domain to X-Site and folds every other filter into the query", () => {
		const single = buildSearchRequest(
			{ provider: "jina", apiKey: "jina-test" },
			{ ...REQUEST, allowedDomains: ["docs.example.com"] },
		);
		expect(single.init.headers["X-Site"]).toBe("docs.example.com");
		expect(decodeURIComponent(new URL(single.url).pathname)).toBe("/typescript satisfies operator");

		const multiple = buildSearchRequest(
			{ provider: "jina", apiKey: "jina-test" },
			{ ...REQUEST, allowedDomains: ["a.example.com", "b.example.com"] },
		);
		expect(multiple.init.headers["X-Site"]).toBeUndefined();
		expect(decodeURIComponent(new URL(multiple.url).pathname)).toBe(
			"/typescript satisfies operator site:a.example.com site:b.example.com",
		);

		const blocked = buildSearchRequest(
			{ provider: "jina", apiKey: "jina-test" },
			{ ...REQUEST, blockedDomains: ["spam.example.com"] },
		);
		expect(blocked.init.headers["X-Site"]).toBeUndefined();
		expect(decodeURIComponent(new URL(blocked.url).pathname)).toBe(
			"/typescript satisfies operator -site:spam.example.com",
		);
	});

	it("keeps the baseUrl override and still appends the encoded query path", () => {
		const proxied = buildSearchRequest(
			{ provider: "jina", apiKey: "jina-test", baseUrl: "https://gateway.example.com/jina/" },
			{ ...REQUEST, maxResults: 3 },
		);
		expect(proxied.url).toBe("https://gateway.example.com/jina/typescript%20satisfies%20operator?count=3");
	});

	it("normalizes the data envelope with a description and content fallback", async () => {
		const results = await normalizeSearchResponse("jina", JSON.parse(fixture("jina-results.json")));

		expect(results).toEqual([
			{
				title: "Documentation - TypeScript 4.9",
				url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
				snippet: expect.stringContaining("satisfies operator"),
			},
			{
				title: "TypeScript satisfies operator, explained",
				url: "https://example.org/typescript/satisfies-operator",
				snippet: expect.stringContaining("type annotation"),
			},
			{
				title: "satisfies - TypeScript handbook notes",
				url: "https://notes.example.net/satisfies",
				snippet: expect.stringContaining("X-Respond-With"),
			},
		]);
	});

	it("searches through the real routing path and sends the recorded answer shape", async () => {
		stubFetch(
			() =>
				new Response(fixture("jina-results.json"), {
					headers: { "Content-Type": "application/json" },
				}),
		);

		const details = await performSearch(jinaConfig({ allowedDomains: ["typescriptlang.org"] }), REQUEST);

		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("https://s.jina.ai/typescript%20satisfies%20operator?count=5");
		expect(fetchCalls[0]?.headers.get("authorization")).toBe("Bearer jina-test");
		expect(fetchCalls[0]?.headers.get("x-site")).toBe("typescriptlang.org");
		expect(fetchCalls[0]?.headers.get("x-respond-with")).toBe("no-content");
		expect(details.error).toBeUndefined();
		expect(details.results.map((item) => item.url)).toEqual([
			"https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
			"https://example.org/typescript/satisfies-operator",
			"https://notes.example.net/satisfies",
		]);
	});

	it("reports a failure code inside a successful response instead of returning no results", async () => {
		stubFetch(() => new Response(JSON.stringify({ code: 402, message: "Insufficient balance" })));

		const details = await performSearch(jinaConfig(), REQUEST);

		expect(details.results).toEqual([]);
		expect(details.error).toBe("Jina API response reported failure (402)");
	});
});
