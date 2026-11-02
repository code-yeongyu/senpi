import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatSearchText } from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import { createWebSearchTool } from "../../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type {
	SearchDetails,
	SearchProgressDetails,
	SearchProviderEntry,
	WebsearchConfig,
} from "../../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../src/core/extensions/types.ts";

// Recorded Keenable response: 25 results, the first with a 642 character snippet. Keenable is the
// fixture engine here because it needs no key and takes a `max_results` count in its request body.
function recordedResults(): { query: string; results: unknown[] } {
	return JSON.parse(
		readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", "keenable-results.json"), "utf8"),
	) as { query: string; results: unknown[] };
}

const RECORDED = recordedResults();

function stubKeenable() {
	const sent: Array<Record<string, unknown>> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (new URL(url).hostname !== "api.keenable.ai") throw new Error(`unexpected request to ${url}`);
			sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return new Response(JSON.stringify(RECORDED), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
	return sent;
}

function config(entry: Partial<SearchProviderEntry> = {}): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: false,
		providers: [{ provider: "keenable", ...entry }],
	};
}

function context(): ExtensionContext {
	return { model: undefined, modelRegistry: undefined } as unknown as ExtensionContext;
}

async function search(
	params: { query: string; max_results?: number },
	entry: Partial<SearchProviderEntry> = {},
): Promise<{ details: SearchDetails; text: string; progress: SearchProgressDetails[] }> {
	const tool = createWebSearchTool(() => ({ ok: true, config: config(entry), source: "test" }));
	const progress: SearchProgressDetails[] = [];
	const result = await tool.execute(
		"call-1",
		params,
		undefined,
		(update) => {
			progress.push(update.details as SearchProgressDetails);
		},
		context() as ExtensionToolContext,
	);
	return { details: result.details as SearchDetails, text: result.content[0]?.text ?? "", progress };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("web_search result count", () => {
	it("#given no max_results #when the search runs #then ten results come back and the engine is asked for ten", async () => {
		const sent = stubKeenable();
		const { details, progress } = await search({ query: RECORDED.query });

		expect(details.results).toHaveLength(10);
		expect(details.truncated).toBe(true);
		expect(sent[0]?.max_results).toBe(10);
		expect(progress[0]?.maxResults).toBe(10);
	});

	it("#given max_results 3 #when the search runs #then three results come back and the engine is asked for three", async () => {
		const sent = stubKeenable();
		const { details, progress } = await search({ query: RECORDED.query, max_results: 3 });

		expect(details.results).toHaveLength(3);
		expect(details.truncated).toBe(true);
		expect(sent[0]?.max_results).toBe(3);
		expect(progress[0]?.maxResults).toBe(3);
	});

	it("#given a provider entry maxResults and no call count #then the entry wins over the default of ten", async () => {
		const sent = stubKeenable();
		const { details } = await search({ query: RECORDED.query }, { maxResults: 7 });

		expect(details.results).toHaveLength(7);
		expect(sent[0]?.max_results).toBe(7);
	});

	it("#given both a call count and a provider entry maxResults #then the call wins", async () => {
		const sent = stubKeenable();
		const { details } = await search({ query: RECORDED.query, max_results: 3 }, { maxResults: 7 });

		expect(details.results).toHaveLength(3);
		expect(sent[0]?.max_results).toBe(3);
	});

	it("#given a call count above the range #then it is clamped to fifty", async () => {
		const sent = stubKeenable();
		const { progress } = await search({ query: RECORDED.query, max_results: 100 });

		expect(progress[0]?.maxResults).toBe(50);
		expect(sent[0]?.max_results).toBe(50);
	});

	it("#given a call count of zero or below #then it is clamped to one", async () => {
		for (const max_results of [0, -5]) {
			const sent = stubKeenable();
			const { details, progress } = await search({ query: RECORDED.query, max_results });

			expect(progress[0]?.maxResults).toBe(1);
			expect(sent[0]?.max_results).toBe(1);
			expect(details.results).toHaveLength(1);
			vi.unstubAllGlobals();
		}
	});

	it("#given a per-call count that matches the fixture exactly #then nothing is reported as truncated", async () => {
		stubKeenable();
		const { details } = await search({ query: RECORDED.query, max_results: 25 });

		expect(details.results).toHaveLength(25);
		expect(details.truncated).toBe(false);
	});
});

describe("web_search snippet cap", () => {
	it("#given a result with a long recorded snippet #when formatting #then the snippet line stops at 500 characters", async () => {
		stubKeenable();
		const { text } = await search({ query: RECORDED.query, max_results: 1 });

		const snippetLine = text.split("\n").find((line) => line.includes("satisfies operator narrows"));
		expect(snippetLine?.length).toBe(3 + 500);
		expect(snippetLine?.endsWith("…")).toBe(true);
	});

	it("#given a snippet exactly at the cap #when formatting #then it is kept unchanged", () => {
		const snippet = "a".repeat(500);
		expect(formatSearchText(detailsWithSnippet(snippet))).toContain(`   ${snippet}`);
	});

	it("#given a snippet past the cap #when formatting #then it is cut to 500 characters", () => {
		const line = formatSearchText(detailsWithSnippet("a".repeat(501)))
			.split("\n")
			.find((line) => line.startsWith("   a"));

		expect(line).toBe(`   ${"a".repeat(499)}…`);
	});
});

function detailsWithSnippet(snippet: string): SearchDetails {
	return {
		provider: "keenable",
		query: "typescript satisfies operator",
		results: [{ title: "Result", url: "https://example.com/result", snippet }],
		durationMs: 1,
		truncated: false,
	};
}
