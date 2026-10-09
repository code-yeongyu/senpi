import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSearchRequest } from "../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../src/core/extensions/builtin/websearch/websearch/search.ts";
import type { SearchProviderEntry, WebsearchConfig } from "../src/core/extensions/builtin/websearch/websearch/types.ts";

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function singleProviderConfig(entry: SearchProviderEntry): WebsearchConfig {
	return { strategy: "priority", fallback: false, auto: false, providers: [entry] };
}

function googleEntry(): SearchProviderEntry {
	return {
		id: "gem",
		provider: "google",
		apiKey: "google-test-key",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		model: "gemini-2.5-flash",
		headers: { "x-goog-user-project": "project-from-registry" },
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("websearch Google hosted search route", () => {
	it("#given a Google API key #when the search request is built #then calls generateContent with the google_search tool", () => {
		// given
		const entry = googleEntry();

		// when
		const built = buildSearchRequest(entry, {
			query: "senpi release",
			maxResults: 5,
			blockedDomains: ["spam.example"],
		});

		// then
		expect(built.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		);
		expect(built.init.method).toBe("POST");
		const headers = new Headers(built.init.headers);
		expect(headers.get("x-goog-api-key")).toBe("google-test-key");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-goog-user-project")).toBe("project-from-registry");
		expect(headers.get("authorization")).toBeNull();
		const body = built.body ?? {};
		expect(body.tools).toEqual([{ google_search: {} }]);
		const prompt = JSON.stringify(body.contents);
		expect(prompt).toContain("senpi release");
		expect(prompt).toContain("-site:spam.example");
	});

	it("#given a Google API root that already names generateContent #when the request is built #then keeps that endpoint", () => {
		// given
		const entry: SearchProviderEntry = {
			...googleEntry(),
			baseUrl: "https://proxy.example.com/v1beta/models/gemini-2.5-pro:generateContent",
		};

		// when
		const built = buildSearchRequest(entry, { query: "q", maxResults: 5 });

		// then
		expect(built.url).toBe("https://proxy.example.com/v1beta/models/gemini-2.5-pro:generateContent");
	});

	it("#given a grounded response #when the search runs #then returns grounding chunks as results and ignores answer-text URLs", async () => {
		// given
		const grounded = {
			candidates: [
				{
					content: { role: "model", parts: [{ text: "It shipped. See https://invented.example.com/z" }] },
					groundingMetadata: {
						webSearchQueries: ["senpi release"],
						groundingChunks: [
							{
								web: {
									uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/one",
									title: "example.com",
								},
							},
							{
								web: {
									uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/two",
									title: "news.example",
								},
							},
						],
						groundingSupports: [{ segment: { text: "It shipped." }, groundingChunkIndices: [1] }],
					},
				},
			],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => jsonResponse(grounded)),
		);

		// when
		const details = await performSearch(singleProviderConfig(googleEntry()), {
			query: "senpi release",
			maxResults: 10,
		});

		// then
		expect(details.error).toBeUndefined();
		expect(details.results).toEqual([
			{ title: "example.com", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/one" },
			{
				title: "news.example",
				url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/two",
				snippet: "It shipped.",
			},
		]);
	});

	it("#given an answer without grounding chunks #when the search runs #then returns zero results", async () => {
		// given
		const ungrounded = {
			candidates: [{ content: { role: "model", parts: [{ text: "From memory: https://memory.example.com/x" }] } }],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => jsonResponse(ungrounded)),
		);

		// when
		const details = await performSearch(singleProviderConfig(googleEntry()), { query: "q", maxResults: 10 });

		// then
		expect(details.results).toEqual([]);
		expect(details.error).toContain("returned no results");
	});
});
