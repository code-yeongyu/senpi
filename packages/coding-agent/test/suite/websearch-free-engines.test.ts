import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	detectSearchChallenge,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type {
	SearchProvider,
	SearchRequest,
	WebsearchConfig,
} from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

// Fixtures are pages recorded on 2026-09-29 for the query "typescript satisfies operator", trimmed to the
// result blocks (or challenge markers) the parsers read, with session identifiers redacted.
function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", name), "utf8");
}

const REQUEST: SearchRequest = { query: "typescript satisfies operator", maxResults: 10 };

function page(body: string, status = 200, url = "https://engine.example/search") {
	return { status, url, body };
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
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

describe("DuckDuckGo HTML engine", () => {
	it("posts the no-JS search form with browser navigation headers", () => {
		const built = buildSearchRequest(
			{ provider: "duckduckgo-html" },
			{ ...REQUEST, allowedDomains: ["docs.example"] },
		);

		expect(built.url).toBe("https://html.duckduckgo.com/html/");
		expect(built.init.method).toBe("POST");
		expect(built.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		expect(built.init.headers["User-Agent"]).toMatch(/Chrome\/\d+/);
		expect(built.init.headers["Sec-Fetch-Mode"]).toBe("navigate");
		expect(new URLSearchParams(built.form).get("q")).toBe("typescript satisfies operator site:docs.example");
	});

	it("normalizes a recorded results page", async () => {
		const results = await normalizeSearchResponse("duckduckgo-html", { html: fixture("duckduckgo-results.html") });

		expect(results.length).toBe(3);
		expect(results[0]?.url).toBe("https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html");
		expect(results[0]?.title).toBe("Documentation - TypeScript 4.9");
		expect(results[0]?.snippet).toContain("satisfies");
		for (const item of results) expect(item.url).not.toContain("duckduckgo.com");
	});

	it("decodes numeric character references in titles and snippets", async () => {
		const results = await normalizeSearchResponse("duckduckgo-html", { html: fixture("duckduckgo-results.html") });

		expect(results[1]?.snippet).toContain("TypeScript's new `satisfies` operator");
		for (const item of results) expect(`${item.title} ${item.snippet}`).not.toMatch(/&#x?[0-9a-f]+;/i);
	});

	it("reports the recorded anomaly page as a challenge, not as an empty result page", () => {
		expect(detectSearchChallenge("duckduckgo-html", page(fixture("duckduckgo-anomaly.html"), 202))).toBe(
			"anomaly page",
		);
		expect(detectSearchChallenge("duckduckgo-html", page(fixture("duckduckgo-results.html")))).toBeUndefined();
	});
});

describe("Startpage engine", () => {
	it("posts the homepage form with its session token", async () => {
		const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				calls.push({ url, init });
				return htmlResponse(
					url.endsWith("/sp/search") ? fixture("startpage-results.html") : fixture("startpage-home.html"),
				);
			}),
		);

		const details = await performSearch(singleEngine("startpage"), REQUEST);

		expect(calls.map((call) => call.url)).toEqual([
			"https://www.startpage.com/",
			"https://www.startpage.com/sp/search",
		]);
		expect(calls[1]?.init?.method).toBe("POST");
		const form = new URLSearchParams(String(calls[1]?.init?.body));
		expect(form.get("sc")).toBe("REDACTEDSCTOKEN");
		expect(form.get("query")).toBe("typescript satisfies operator");
		expect(details.error).toBeUndefined();
		expect(details.results[0]).toEqual({
			title: "Documentation - TypeScript 4.9",
			url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
			snippet: expect.stringContaining("satisfies"),
		});
	});

	it("normalizes a recorded results page", async () => {
		const results = await normalizeSearchResponse("startpage", { html: fixture("startpage-results.html") });

		expect(results.length).toBe(3);
		for (const item of results) {
			expect(item.url).toMatch(/^https:\/\//);
			expect(item.url).not.toContain("startpage.com");
			expect(item.title.length).toBeGreaterThan(0);
		}
	});

	it("reports the proof-of-work interstitial as a challenge and stops at the homepage", async () => {
		const fetchMock = vi.fn(async () => htmlResponse(fixture("startpage-anubis.html")));
		vi.stubGlobal("fetch", fetchMock);

		const details = await performSearch(singleEngine("startpage"), REQUEST);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(details.blocked).toBe("challenge");
		expect(details.attempts?.[0]?.blocked).toBe("challenge");
		expect(details.error).toContain("proof-of-work interstitial");
	});
});

describe("Mojeek engine", () => {
	it("requests the results page with a result count", () => {
		const built = buildSearchRequest({ provider: "mojeek" }, { ...REQUEST, maxResults: 50 });
		const url = new URL(built.url);

		expect(url.origin + url.pathname).toBe("https://www.mojeek.com/search");
		expect(url.searchParams.get("q")).toBe("typescript satisfies operator");
		expect(url.searchParams.get("t")).toBe("20");
		expect(built.init.headers["User-Agent"]).toMatch(/Chrome\/\d+/);
	});

	it("normalizes a recorded results page", async () => {
		const results = await normalizeSearchResponse("mojeek", { html: fixture("mojeek-results.html") });

		expect(results[0]).toEqual({
			title: "typescript ‘satisfies‘ operator · schpet’s notebook",
			url: "https://schpet.com/linklog/typescript-satisfies-operator",
			snippet: expect.stringContaining("satisfies"),
		});
		expect(results.length).toBe(3);
	});

	it("reports the recorded verification page as a challenge", () => {
		expect(detectSearchChallenge("mojeek", page(fixture("mojeek-captcha.html")))).toBe("ALTCHA verification page");
		expect(detectSearchChallenge("mojeek", page(fixture("mojeek-results.html")))).toBeUndefined();
	});
});

describe("Ecosia engine", () => {
	it("requests the results page", () => {
		const url = new URL(buildSearchRequest({ provider: "ecosia" }, REQUEST).url);

		expect(url.origin + url.pathname).toBe("https://www.ecosia.org/search");
		expect(url.searchParams.get("q")).toBe("typescript satisfies operator");
	});

	it("normalizes a recorded results page", async () => {
		const results = await normalizeSearchResponse("ecosia", { html: fixture("ecosia-results.html") });

		expect(results.length).toBe(3);
		for (const item of results) {
			expect(item.url).not.toContain("ecosia.org");
			expect(item.snippet?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it("reports the recorded firewall page as a challenge even though it is an HTTP 403", async () => {
		expect(detectSearchChallenge("ecosia", page(fixture("ecosia-firewall.html"), 403))).toBe("firewall challenge");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => htmlResponse(fixture("ecosia-firewall.html"), 403)),
		);

		const details = await performSearch(singleEngine("ecosia"), REQUEST);

		expect(details.blocked).toBe("challenge");
		expect(details.error).toContain("firewall challenge");
	});
});

describe("Google results-page engine", () => {
	it("requests the plain web results page", () => {
		const url = new URL(buildSearchRequest({ provider: "google-html" }, REQUEST).url);

		expect(url.origin + url.pathname).toBe("https://www.google.com/search");
		expect(url.searchParams.get("q")).toBe("typescript satisfies operator");
		expect(url.searchParams.get("udm")).toBe("14");
		expect(url.searchParams.get("num")).toBe("10");
	});

	it("normalizes a recorded results page", async () => {
		const results = await normalizeSearchResponse("google-html", { html: fixture("google-results.html") });

		expect(results[0]).toEqual({
			title: "Documentation - TypeScript 4.9",
			url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
			snippet: expect.stringContaining("satisfies"),
		});
		for (const item of results) expect(item.url).not.toContain("google.com");
	});

	it("reports the recorded JavaScript wall as a challenge", () => {
		expect(detectSearchChallenge("google-html", page(fixture("google-enablejs.html")))).toBe("JavaScript wall");
		expect(
			detectSearchChallenge("google-html", page("<html></html>", 200, "https://www.google.com/sorry/index")),
		).toBe("unusual-traffic CAPTCHA");
		expect(detectSearchChallenge("google-html", page(fixture("google-results.html")))).toBeUndefined();
	});
});

describe("Exa hosted MCP engine (anonymous tier)", () => {
	it("calls the web search tool over JSON-RPC without any key", () => {
		const built = buildSearchRequest({ provider: "exa-mcp" }, REQUEST);

		expect(built.url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa");
		expect(built.init.method).toBe("POST");
		expect(built.init.headers.Accept).toBe("application/json, text/event-stream");
		expect(JSON.stringify(built)).not.toMatch(/apiKey|exaApiKey|Authorization|session/i);
		expect(built.body).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query: "typescript satisfies operator", numResults: 10 } },
		});
	});

	it("normalizes a recorded event-stream answer", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(fixture("exa-mcp-results.sse"), { headers: { "Content-Type": "text/event-stream" } }),
			),
		);

		const details = await performSearch(singleEngine("exa-mcp"), REQUEST);

		expect(details.error).toBeUndefined();
		expect(details.results.length).toBe(3);
		expect(details.results[0]).toMatchObject({
			title: "Documentation - TypeScript 4.9",
			url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
		});
		expect(details.results[0]?.snippet).toContain("satisfies");
	});

	it("puts the anonymous rate limit (429) on the block list with its Retry-After", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } })),
		);

		const details = await performSearch(singleEngine("exa-mcp"), REQUEST);

		expect(details.blocked).toBe("rate_limited");
		expect(details.retryAfterSeconds).toBe(120);
	});
});

describe("SearXNG engine (self-hosted)", () => {
	it("requires a baseUrl and accepts a local http instance", () => {
		expect(validateProviderConfig({ provider: "searxng" }).ok).toBe(false);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "http://localhost:8888" }).ok).toBe(true);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "http://192.168.1.20:8080/searx" }).ok).toBe(true);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "http://searxng:8080" }).ok).toBe(true);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "https://searx.example.org" }).ok).toBe(true);
	});

	it("rejects cleartext public hosts, credentials in the URL, and local http for every other provider", () => {
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "http://searx.example.org" }).ok).toBe(false);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "http://user:pass@localhost:8888" }).ok).toBe(
			false,
		);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "file:///etc/passwd" }).ok).toBe(false);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "http://fdroid.org" }).ok).toBe(false);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "http://[2001:db8::1]:8080" }).ok).toBe(false);
		expect(validateProviderConfig({ provider: "searxng", baseUrl: "http://[fd00::20]:8080" }).ok).toBe(true);
		expect(validateProviderConfig({ provider: "duckduckgo-html", baseUrl: "http://localhost:8888" }).ok).toBe(false);
		expect(validateProviderConfig({ provider: "exa", apiKey: "exa-test", baseUrl: "http://127.0.0.1:9000" }).ok).toBe(
			false,
		);
	});

	it("requests the JSON search endpoint under the instance path", () => {
		expect(buildSearchRequest({ provider: "searxng", baseUrl: "http://localhost:8888/" }, REQUEST).url).toBe(
			"http://localhost:8888/search?q=typescript+satisfies+operator&format=json",
		);
		expect(buildSearchRequest({ provider: "searxng", baseUrl: "https://example.org/searx" }, REQUEST).url).toBe(
			"https://example.org/searx/search?q=typescript+satisfies+operator&format=json",
		);
	});

	it("normalizes a recorded JSON answer", async () => {
		const results = await normalizeSearchResponse("searxng", JSON.parse(fixture("searxng-results.json")));

		expect(results.length).toBe(3);
		expect(results[0]).toEqual({
			title: "TypeScript: Documentation - TypeScript 4.9",
			url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
			snippet: expect.stringContaining("satisfies"),
		});
	});
});
