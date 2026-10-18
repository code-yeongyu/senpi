import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSearchResponse } from "../../../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type { JsonObject, WebsearchConfig } from "../../../src/core/extensions/builtin/websearch/websearch/types.ts";

const ANSWER_ONLY: JsonObject = {
	output: [
		{
			type: "message",
			content: [{ type: "output_text", text: "See https://made-up.example.com/page for details.", annotations: [] }],
		},
	],
};

describe("regression #2337: answer-text URLs are not web search sources", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each(["openai", "codex", "xai"] as const)(
		"%s ignores URLs the model wrote without searching",
		async (provider) => {
			expect(await normalizeSearchResponse(provider, ANSWER_ONLY)).toEqual([]);
		},
	);

	it("keeps sources a web_search_call returned", async () => {
		const payload: JsonObject = {
			output: [
				{ type: "web_search_call", action: { sources: [{ url: "https://found.example.com/a" }] } },
				...(ANSWER_ONLY.output as JsonObject[]),
			],
		};
		expect((await normalizeSearchResponse("openai", payload)).map((item) => item.url)).toEqual([
			"https://found.example.com/a",
		]);
	});

	it("keeps xAI server citations", async () => {
		const payload: JsonObject = { ...ANSWER_ONLY, citations: ["https://cited.example.com/x"] };
		expect((await normalizeSearchResponse("xai", payload)).map((item) => item.url)).toEqual([
			"https://cited.example.com/x",
		]);
	});

	it("falls back to the next provider when the answer has no search output", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("openai")
					? Response.json(ANSWER_ONLY)
					: Response.json({ results: [{ url: "https://exa.example.com/r", title: "r" }] }),
			),
		);
		const config: WebsearchConfig = {
			strategy: "priority",
			fallback: true,
			auto: false,
			providers: [
				{ provider: "openai", apiKey: "test-key" },
				{ provider: "exa", apiKey: "test-key" },
			],
		};

		const details = await performSearch(config, { query: "q", maxResults: 5 });

		expect(details.provider).toBe("exa");
		expect(details.results.map((item) => item.url)).toEqual(["https://exa.example.com/r"]);
		expect(details.attempts?.[0]?.error).toContain("returned no results");
	});
});
