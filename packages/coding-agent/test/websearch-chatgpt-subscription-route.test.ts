import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateProviderConfig } from "../src/core/extensions/builtin/websearch/websearch/config.ts";
import { buildSearchRequest } from "../src/core/extensions/builtin/websearch/websearch/providers.ts";
import { performSearch } from "../src/core/extensions/builtin/websearch/websearch/search.ts";
import type { SearchProviderEntry, WebsearchConfig } from "../src/core/extensions/builtin/websearch/websearch/types.ts";

const ACCOUNT_ID = "acct-test-1234";

function base64Url(value: string): string {
	return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function subscriptionToken(): string {
	const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
	const payload = base64Url(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } }));
	return `${header}.${payload}.signature`;
}

function sse(events: unknown[]): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function sseResponse(events: unknown[]): Response {
	return new Response(sse(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function singleProviderConfig(entry: SearchProviderEntry): WebsearchConfig {
	return { strategy: "priority", fallback: false, auto: false, providers: [entry] };
}

function subscriptionEntry(): SearchProviderEntry {
	return {
		id: "sub",
		provider: "chatgpt-subscription",
		apiKey: subscriptionToken(),
		baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		model: "gpt-5.5",
		headers: { "x-registry-header": "registry-value" },
	};
}

const SEARCHED_EVENTS = [
	{ type: "response.created", response: { id: "resp_1", model: "gpt-5.5" } },
	{ type: "response.web_search_call.searching", item_id: "ws_1" },
	{
		type: "response.output_item.done",
		item: {
			type: "web_search_call",
			id: "ws_1",
			status: "completed",
			action: {
				type: "search",
				query: "senpi release",
				sources: [
					{ type: "url", url: "https://docs.example.com/a?utm_source=openai" },
					{ type: "url", url: "https://news.example.com/b" },
				],
			},
		},
	},
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "Per News B the release shipped; also see https://invented.example.com/c for details.",
					annotations: [
						{
							type: "url_citation",
							url: "https://news.example.com/b",
							title: "News B",
							start_index: 4,
							end_index: 10,
						},
					],
				},
			],
		},
	},
	{ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } },
];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("websearch ChatGPT subscription hosted route", () => {
	it("#given a subscription credential #when the search request is built #then posts a streaming, unstored web_search request with every credential header", () => {
		// given
		const entry = subscriptionEntry();

		// when
		const built = buildSearchRequest(entry, { query: "senpi release", maxResults: 5 });

		// then
		expect(built.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(built.init.method).toBe("POST");
		const headers = new Headers(built.init.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${subscriptionToken()}`);
		expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT_ID);
		expect(headers.get("openai-beta")).toBe("responses=experimental");
		expect(headers.get("originator")).toBe("senpi");
		expect(headers.get("user-agent")).toMatch(/^senpi \(/);
		expect(headers.get("accept")).toBe("text/event-stream");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-registry-header")).toBe("registry-value");
		const body = built.body ?? {};
		expect(body.model).toBe("gpt-5.5");
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(typeof body.instructions).toBe("string");
		expect(body.include).toEqual(["web_search_call.action.sources"]);
		expect(body.tools).toEqual([{ type: "web_search", external_web_access: true }]);
		expect(body.tool_choice).toEqual({ type: "web_search" });
		expect(JSON.stringify(body.input)).toContain("senpi release");
	});

	it("#given allowed domains #when the subscription request is built #then passes them as the web_search filter", () => {
		// given
		const entry = subscriptionEntry();

		// when
		const built = buildSearchRequest(entry, { query: "q", maxResults: 5, allowedDomains: ["example.com"] });

		// then
		expect(built.body?.tools).toEqual([
			{ type: "web_search", external_web_access: true, filters: { allowed_domains: ["example.com"] } },
		]);
	});

	it("#given a streamed response with a web_search_call #when the search runs #then returns search sources and citations but never answer-text URLs", async () => {
		// given
		const fetchMock = vi.fn<typeof fetch>(async () => sseResponse(SEARCHED_EVENTS));
		vi.stubGlobal("fetch", fetchMock);

		// when
		const details = await performSearch(singleProviderConfig(subscriptionEntry()), {
			query: "senpi release",
			maxResults: 10,
		});

		// then
		expect(details.error).toBeUndefined();
		expect(details.results.map((item) => item.url)).toEqual([
			"https://news.example.com/b",
			"https://docs.example.com/a",
		]);
		expect(details.results[0]?.title).toBe("News B");
		expect(details.results.some((item) => item.url.includes("invented.example.com"))).toBe(false);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(ACCOUNT_ID);
	});

	it("#given a streamed answer without any web_search_call #when the search runs #then rejects it as zero results", async () => {
		// given
		const unsearched = [
			{ type: "response.created", response: { id: "resp_2" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: "From memory: https://memory.example.com/x",
							annotations: [{ type: "url_citation", url: "https://memory.example.com/x", title: "Memory" }],
						},
					],
				},
			},
			{ type: "response.completed", response: { id: "resp_2", output: [] } },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => sseResponse(unsearched)),
		);

		// when
		const details = await performSearch(singleProviderConfig(subscriptionEntry()), { query: "q", maxResults: 10 });

		// then
		expect(details.results).toEqual([]);
		expect(details.error).toContain("returned no results");
	});

	it("#given a stream that fails mid-response #when the search runs #then reports the backend failure", async () => {
		// given
		const failed = [
			{ type: "response.created", response: { id: "resp_3" } },
			{
				type: "response.failed",
				response: { id: "resp_3", error: { code: "usage_limit_reached", message: "usage limit reached" } },
			},
		];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => sseResponse(failed)),
		);

		// when
		const details = await performSearch(singleProviderConfig(subscriptionEntry()), { query: "q", maxResults: 10 });

		// then
		expect(details.results).toEqual([]);
		expect(details.error).toContain("usage limit reached");
	});
});

describe("websearch hosted route config", () => {
	it.each(["chatgpt-subscription", "google"] as const)(
		"#given a %s entry without apiKey #when validated #then accepts it for session-credential resolution",
		(provider) => {
			// given
			const entry: SearchProviderEntry = { provider };

			// when
			const validation = validateProviderConfig(entry);

			// then
			expect(validation.ok).toBe(true);
		},
	);

	it("#given the existing codex entry without apiKey #when validated #then still requires an API key", () => {
		// given
		const entry: SearchProviderEntry = { provider: "codex" };

		// when
		const validation = validateProviderConfig(entry);

		// then
		expect(validation.ok).toBe(false);
	});
});
