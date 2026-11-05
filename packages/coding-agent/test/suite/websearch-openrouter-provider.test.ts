import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateProviderConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type { SearchRequest, WebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

// Shaped after OpenRouter's published chat-completion annotation schema for the `web` plugin, with every
// identifier replaced: `url_citation` annotations are the only results, an answer without them is no results.
function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", name), "utf8");
}

const REQUEST: SearchRequest = { query: "typescript satisfies operator", maxResults: 10 };

function openRouterConfig(extra: Partial<WebsearchConfig["providers"][number]> = {}): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: false,
		providers: [{ provider: "openrouter", apiKey: "or-test", model: "anthropic/claude-sonnet-4.5", ...extra }],
	};
}

function chatResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

const realFetch = globalThis.fetch;

function stubFetch(response: () => Promise<Response>): void {
	globalThis.fetch = response;
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("OpenRouter grounded web search provider", () => {
	it("requires an api key and the chat model the plugin runs on", () => {
		const missingKey = validateProviderConfig({ provider: "openrouter", model: "openai/gpt-5.2" });
		expect(missingKey.ok).toBe(false);
		if (!missingKey.ok) expect(missingKey.reason).toBe("missing_api_key");

		const missingModel = validateProviderConfig({ provider: "openrouter", apiKey: "or-test" });
		expect(missingModel.ok).toBe(false);
		if (!missingModel.ok) expect(missingModel.reason).toBe("invalid_config");

		expect(validateProviderConfig({ provider: "openrouter", apiKey: "or-test", model: "openai/gpt-5.2" }).ok).toBe(
			true,
		);
	});

	it("posts the query to chat/completions with the web plugin and the configured model", () => {
		const request = buildSearchRequest(
			{ provider: "openrouter", apiKey: "or-test", model: "anthropic/claude-sonnet-4.5" },
			{ query: "ground this answer", maxResults: 7 },
		);

		expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers.Authorization).toBe("Bearer or-test");
		expect(request.body).toEqual({
			model: "anthropic/claude-sonnet-4.5",
			plugins: [{ id: "web", max_results: 7 }],
			messages: [{ role: "user", content: "ground this answer" }],
		});
	});

	it("appends the path to a baseUrl override once and caps max_results at 50", () => {
		const trailing = buildSearchRequest(
			{
				provider: "openrouter",
				apiKey: "or-test",
				model: "openai/gpt-5.2",
				baseUrl: "https://gateway.example.com/api/v1/",
			},
			{ query: "q", maxResults: 5 },
		);
		expect(trailing.url).toBe("https://gateway.example.com/api/v1/chat/completions");

		const alreadyComplete = buildSearchRequest(
			{
				provider: "openrouter",
				apiKey: "or-test",
				model: "openai/gpt-5.2",
				baseUrl: "https://gateway.example.com/api/v1/chat/completions",
			},
			{ query: "q", maxResults: 5 },
		);
		expect(alreadyComplete.url).toBe("https://gateway.example.com/api/v1/chat/completions");

		const capped = buildSearchRequest(
			{ provider: "openrouter", apiKey: "or-test", model: "openai/gpt-5.2" },
			{ query: "q", maxResults: 500 },
		);
		expect(capped.body).toEqual({
			model: "openai/gpt-5.2",
			plugins: [{ id: "web", max_results: 50 }],
			messages: [{ role: "user", content: "q" }],
		});
	});

	it("maps url_citation annotations into results, deduping a page cited twice and dropping other annotations", async () => {
		const results = await normalizeSearchResponse("openrouter", JSON.parse(fixture("openrouter-grounded.json")));

		expect(results).toEqual([
			{
				title: "Documentation - TypeScript 4.9",
				url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
				snippet:
					"The satisfies operator validates that an expression matches a type without changing the resulting type.",
			},
			{
				title: "Announcing TypeScript 4.9",
				url: "https://devblogs.microsoft.com/typescript/announcing-typescript-4-9/",
				snippet: "satisfies makes sure an expression's type matches a type without widening it.",
			},
		]);
	});

	it("returns the grounded citations of a live-shaped response and never the links written in the answer", async () => {
		stubFetch(async () => chatResponse(fixture("openrouter-grounded.json")));
		const details = await performSearch(openRouterConfig(), REQUEST);

		expect(details.error).toBeUndefined();
		expect(details.provider).toBe("openrouter");
		expect(details.results.map((item) => item.url)).toEqual([
			"https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
			"https://devblogs.microsoft.com/typescript/announcing-typescript-4-9/",
		]);
		expect(details.results.some((item) => item.url.includes("uncited.example.com"))).toBe(false);
	});

	it("reports an answer that came back without citations as an error, never as results", async () => {
		stubFetch(async () => chatResponse(fixture("openrouter-answer-only.json")));

		const details = await performSearch(openRouterConfig(), REQUEST);

		expect(details.results).toEqual([]);
		expect(details.error).toContain("Search provider openrouter returned no results");
	});

	it("surfaces an upstream HTTP failure as the attempt error", async () => {
		stubFetch(async () => chatResponse(JSON.stringify({ error: { message: "upstream unavailable" } }), 503));

		const details = await performSearch(openRouterConfig(), REQUEST);

		expect(details.results).toEqual([]);
		expect(details.error).toContain("Search failed with HTTP 503: upstream unavailable");
	});
});
