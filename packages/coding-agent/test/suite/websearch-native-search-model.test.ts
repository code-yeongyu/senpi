import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	anthropicSearchResponse,
	captureFetch,
	config,
	emptyAnthropicResponse,
	model,
	otherProviderLuna,
	PROXY_BASE_URL,
	PROXY_MESSAGES_URL,
	proxyHaiku,
	proxySonnet,
	registryWith,
	runSearch,
	sessionOpus,
} from "./websearch-native-search-model-fixtures.ts";

// senpi#2340: native hosted web search may run on a cheaper model of the session's own provider route,
// retrying on the session model before any other provider.

describe("websearch native search model (senpi#2340)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("#given nativeModel names a model on the session route #when searching #then the native request body carries that model and the attempt names it", async () => {
		// given
		const registry = registryWith([sessionOpus, proxySonnet, proxyHaiku]);
		const { requests, fetchMock } = captureFetch([() => anthropicSearchResponse("https://example.com/a")]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		const { details, text } = await runSearch(config("claude-sonnet-4-5"), registry);

		// then
		expect(requests).toEqual([{ url: PROXY_MESSAGES_URL, model: "claude-sonnet-4-5", apiKey: "proxy-session-key" }]);
		expect(details.model).toBe("claude-sonnet-4-5");
		expect(details.attempts?.map((attempt) => attempt.model)).toEqual(["claude-sonnet-4-5"]);
		expect(text).toContain("via claude-proxy/native (claude-sonnet-4-5)");
		expect(text).toContain("Routing attempts: claude-proxy/native (claude-sonnet-4-5) 1 result");
	});

	it("#given the chosen model answers with an HTTP error #when searching #then the same route retries with the session model before other providers", async () => {
		// given
		const registry = registryWith([sessionOpus, proxyHaiku]);
		const { requests, fetchMock } = captureFetch([
			() => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }),
			() => anthropicSearchResponse("https://example.com/fallback"),
		]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		const { details, text } = await runSearch(config("claude-haiku-4-5"), registry);

		// then
		expect(requests.map((request) => [request.url, request.model])).toEqual([
			[PROXY_MESSAGES_URL, "claude-haiku-4-5"],
			[PROXY_MESSAGES_URL, "claude-opus-4-5"],
		]);
		expect(details.error).toBeUndefined();
		expect(details.model).toBe("claude-opus-4-5");
		expect(text).toContain(
			"Routing attempts: claude-proxy/native (claude-haiku-4-5) failed: Search failed with HTTP 404: model not found -> claude-proxy/native (claude-opus-4-5) 1 result",
		);
	});

	it("#given the chosen model returns zero results #when searching #then the session model is tried next on the same route", async () => {
		// given
		const registry = registryWith([sessionOpus, proxyHaiku]);
		const { requests, fetchMock } = captureFetch([
			() => emptyAnthropicResponse(),
			() => anthropicSearchResponse("https://example.com/fallback"),
		]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		const { details } = await runSearch(config("claude-haiku-4-5"), registry);

		// then
		expect(requests.map((request) => request.model)).toEqual(["claude-haiku-4-5", "claude-opus-4-5"]);
		expect(details.attempts?.map((attempt) => [attempt.model, attempt.resultsCount])).toEqual([
			["claude-haiku-4-5", 0],
			["claude-opus-4-5", 1],
		]);
	});

	it("#given nativeModel names another provider's model #when searching #then it is ignored and the session model serves the search", async () => {
		// given
		const registry = registryWith([sessionOpus, proxyHaiku, otherProviderLuna]);
		const { requests, fetchMock } = captureFetch([() => anthropicSearchResponse("https://example.com/session")]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		await runSearch(config("gpt-5.6-luna"), registry);

		// then
		expect(requests).toEqual([{ url: PROXY_MESSAGES_URL, model: "claude-opus-4-5", apiKey: "proxy-session-key" }]);
	});

	it("#given no nativeModel and a cheaper default search model on the same route #when searching #then the request uses that cheaper model", async () => {
		// given
		const registry = registryWith([sessionOpus, proxySonnet, proxyHaiku]);
		const { requests, fetchMock } = captureFetch([() => anthropicSearchResponse("https://example.com/cheap")]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		const { details } = await runSearch(config(), registry);

		// then
		expect(requests.map((request) => request.model)).toEqual(["claude-haiku-4-5"]);
		expect(details.model).toBe("claude-haiku-4-5");
	});

	it("#given no nativeModel and no cheaper default model on the route #when searching #then the request body keeps the session model", async () => {
		// given
		const registry = registryWith([sessionOpus, proxySonnet]);
		const { requests, fetchMock } = captureFetch([() => anthropicSearchResponse("https://example.com/session")]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		await runSearch(config(), registry);

		// then
		expect(requests.map((request) => request.model)).toEqual(["claude-opus-4-5"]);
	});

	it("#given the default search model has no lower catalog cost than the session model #when searching #then the session model is kept", async () => {
		// given
		const freeSession = model("claude-proxy", "claude-opus-4-5", "anthropic-messages", PROXY_BASE_URL, 0, 0);
		const freeHaiku = model("claude-proxy", "claude-haiku-4-5", "anthropic-messages", PROXY_BASE_URL, 0, 0);
		const registry = registryWith([freeSession, freeHaiku]);
		const { requests, fetchMock } = captureFetch([() => anthropicSearchResponse("https://example.com/session")]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		await runSearch(config(), registry, freeSession);

		// then
		expect(requests.map((request) => request.model)).toEqual(["claude-opus-4-5"]);
	});

	it("#given the cheaper model sits on a different endpoint of the same provider #when searching #then it is not used for the session route", async () => {
		// given
		const elsewhereHaiku = model(
			"claude-proxy",
			"claude-haiku-4-5",
			"anthropic-messages",
			"https://other-claude-proxy.example.com",
			1,
			5,
		);
		const registry = registryWith([sessionOpus, elsewhereHaiku]);
		const { requests, fetchMock } = captureFetch([() => anthropicSearchResponse("https://example.com/session")]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		await runSearch({ ...config(), providers: [{ id: "free", provider: "duckduckgo-html" }] }, registry);

		// then
		expect(requests[0]).toEqual({ url: PROXY_MESSAGES_URL, model: "claude-opus-4-5", apiKey: "proxy-session-key" });
	});

	it('#given nativeModel "session" #when a cheaper default exists #then the session model is used', async () => {
		// given
		const registry = registryWith([sessionOpus, proxyHaiku]);
		const { requests, fetchMock } = captureFetch([() => anthropicSearchResponse("https://example.com/session")]);
		vi.stubGlobal("fetch", fetchMock);

		// when
		await runSearch(config("session"), registry);

		// then
		expect(requests.map((request) => request.model)).toEqual(["claude-opus-4-5"]);
	});
});
