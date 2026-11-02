import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	KEYLESS_PROVIDERS,
	validateProviderConfig,
} from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type { SearchRequest, WebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

// The keyless answer was recorded on 2026-11-02 from the public Parallel MCP `web_search` tool for the query
// "typescript satisfies operator", trimmed to three results with one-to-two excerpts each; search ids, the
// server session id and the search summary are redacted. The keyed answer is the same recorded results in the
// beta Search API envelope.
function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", name), "utf8");
}

const REQUEST: SearchRequest = { query: "typescript satisfies operator", maxResults: 10 };
const FIRST_URL = "https://blog.logrocket.com/javascript-typescript-shorthands";

function singleEngine(extra: Partial<WebsearchConfig["providers"][number]> = {}): WebsearchConfig {
	return { strategy: "priority", fallback: true, auto: false, providers: [{ provider: "parallel", ...extra }] };
}

function jsonResponse(body: string, contentType = "application/json"): Response {
	return new Response(body, { headers: { "Content-Type": contentType } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Parallel provider", () => {
	it("works without a key and is listed among the keyless engines", () => {
		expect(validateProviderConfig({ provider: "parallel" }).ok).toBe(true);
		expect(KEYLESS_PROVIDERS.has("parallel")).toBe(true);
	});

	it("calls the public MCP web_search tool over JSON-RPC without any session or model identifier", () => {
		const built = buildSearchRequest({ provider: "parallel" }, REQUEST);

		expect(built.url).toBe("https://search.parallel.ai/mcp");
		expect(built.init.method).toBe("POST");
		expect(built.init.headers.Accept).toBe("application/json, text/event-stream");
		expect(built.body).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search",
				arguments: {
					objective: "typescript satisfies operator",
					search_queries: ["typescript satisfies operator"],
				},
			},
		});
		expect(JSON.stringify(built.body)).not.toMatch(/session|model|apiKey|authorization/i);
	});

	it("folds domain filters into the MCP search query", () => {
		const built = buildSearchRequest(
			{ provider: "parallel" },
			{ ...REQUEST, allowedDomains: ["docs.example.com"], blockedDomains: ["reddit.com"] },
		);

		expect(built.body).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search",
				arguments: {
					objective: "typescript satisfies operator",
					search_queries: ["typescript satisfies operator site:docs.example.com"],
				},
			},
		});

		const blockedOnly = buildSearchRequest({ provider: "parallel" }, { ...REQUEST, blockedDomains: ["reddit.com"] });
		expect(JSON.stringify(blockedOnly.body)).toContain("typescript satisfies operator -site:reddit.com");
	});

	it("posts the keyed beta search with its channel header, fast mode and excerpt budget", () => {
		const built = buildSearchRequest({ provider: "parallel", apiKey: "parallel-test" }, REQUEST);

		expect(built.url).toBe("https://api.parallel.ai/v1beta/search");
		expect(built.init.method).toBe("POST");
		expect(built.init.headers["x-api-key"]).toBe("parallel-test");
		expect(built.init.headers["parallel-beta"]).toBe("search-extract-2025-10-10");
		expect(built.init.headers["Content-Type"]).toBe("application/json");
		expect(built.body).toEqual({
			objective: "typescript satisfies operator",
			search_queries: ["typescript satisfies operator"],
			mode: "fast",
			excerpts: { max_chars_per_result: 10000 },
		});
	});

	it("maps domain filters onto source_policy, keeping exclusions only without an allow list", () => {
		const base = {
			objective: "typescript satisfies operator",
			search_queries: ["typescript satisfies operator"],
			mode: "fast",
			excerpts: { max_chars_per_result: 10000 },
		};

		const included = buildSearchRequest(
			{ provider: "parallel", apiKey: "parallel-test" },
			{ ...REQUEST, allowedDomains: ["docs.example.com"], blockedDomains: ["reddit.com"] },
		);
		expect(included.body).toEqual({ ...base, source_policy: { include_domains: ["docs.example.com"] } });

		const excluded = buildSearchRequest(
			{ provider: "parallel", apiKey: "parallel-test" },
			{ ...REQUEST, blockedDomains: ["reddit.com"] },
		);
		expect(excluded.body).toEqual({ ...base, source_policy: { exclude_domains: ["reddit.com"] } });
	});

	it("normalizes the recorded keyless MCP answer", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(fixture("parallel-mcp-results.json"))),
		);

		const details = await performSearch(singleEngine(), REQUEST);

		expect(details.error).toBeUndefined();
		expect(details.provider).toBe("parallel");
		expect(details.results).toHaveLength(3);
		expect(details.results[0]).toEqual({
			title: "18 JavaScript and TypeScript shorthands to know - LogRocket Blog",
			url: FIRST_URL,
			snippet: expect.stringContaining("satisfies"),
			publishedAt: "2023-01-03",
		});
		expect(details.results[0]?.snippet).not.toContain("\n");
		expect(details.results[1]?.publishedAt).toBeUndefined();
		expect(details.results[2]?.publishedAt).toBe("2025-05-08");
	});

	it("reads the payload from a content part when the tool result carries only text", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(fixture("parallel-mcp-content-text.sse"), "text/event-stream")),
		);

		const details = await performSearch(singleEngine(), REQUEST);

		expect(details.error).toBeUndefined();
		expect(details.results).toHaveLength(3);
		expect(details.results[0]?.url).toBe(FIRST_URL);
	});

	it("surfaces an MCP tool error returned inside a successful response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { isError: true, content: [{ type: "text", text: "query rejected" }] },
					}),
				),
			),
		);

		const details = await performSearch(singleEngine(), REQUEST);

		expect(details.attempts?.[0]?.error).toBe("Parallel search error: query rejected");
		expect(details.error).toContain("Parallel search error: query rejected");
		expect(details.results).toEqual([]);
	});

	it("normalizes the beta Search API answer without the JSON-RPC envelope", async () => {
		const keyed = singleEngine({ apiKey: "parallel-test" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(fixture("parallel-rest-results.json"))),
		);

		const results = await normalizeSearchResponse("parallel", JSON.parse(fixture("parallel-rest-results.json")));
		expect(results.map((item) => item.url)).toEqual([
			FIRST_URL,
			"https://www.zetcode.com/typescript/satisfies/",
			"https://blog.logrocket.com/type-casting-typescript",
		]);

		const details = await performSearch(keyed, REQUEST);
		expect(details.error).toBeUndefined();
		expect(details.results).toHaveLength(3);
	});
});
