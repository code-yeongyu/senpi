import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	createSearchRoutingState,
	ENGINE_COOLDOWN_BASE_MS,
	formatSearchText,
	performSearch,
	providerEntryLabel,
} from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import { createWebSearchTool } from "../../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type {
	SearchDetails,
	SearchRenderDetails,
	WebsearchConfig,
} from "../../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../src/core/extensions/types.ts";

function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", name), "utf8");
}

const REQUEST = { query: "typescript satisfies operator", maxResults: 10 };

type Route = (url: string) => Response | Promise<Response>;

/** Answers by host; a host missing from the table fails the test loudly instead of reaching the network. */
function stubEngines(routes: Record<string, Route>) {
	const hosts: string[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		const host = new URL(url).hostname;
		hosts.push(host);
		const route = routes[host];
		if (!route) throw new Error(`unexpected request to ${url}`);
		return route(url);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { hosts, fetchMock };
}

const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

const ddgChallenged: Route = () => html(fixture("duckduckgo-anomaly.html"), 202);
const ddgAnswers: Route = () => html(fixture("duckduckgo-results.html"));
const startpageAnswers: Route = (url) =>
	html(url.endsWith("/sp/search") ? fixture("startpage-results.html") : fixture("startpage-home.html"));

function freeChain(): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: false,
		providers: [{ provider: "duckduckgo-html" }, { provider: "startpage" }],
	};
}

function labels(details: SearchDetails): string[] {
	return (details.attempts ?? []).map(
		(attempt) =>
			`${providerEntryLabel(attempt)}:${attempt.skipped ? "skipped" : (attempt.blocked ?? attempt.resultsCount)}`,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("default free engine chain", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "websearch-free-chain-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("tries keyless engines in order when no websearch.json exists", async () => {
		const loaded = await loadWebsearchConfig({ cwd: join(root, "project"), homeDir: join(root, "home") });

		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.config.strategy).toBe("priority");
		expect(loaded.config.providers.map(providerEntryLabel)).toEqual([
			"duckduckgo-html",
			"exa-mcp",
			"startpage",
			"mojeek",
			"ecosia",
			"google-html",
		]);
		for (const entry of loaded.config.providers) {
			expect(entry.apiKey).toBeUndefined();
			expect(entry.model).toBeUndefined();
		}
	});

	it("loads every websearch.json example in the web search docs, and the limiting ones contact only what they list", async () => {
		const page = readFileSync(join(import.meta.dirname, "..", "..", "docs", "web-search.md"), "utf8");
		const examples = [...page.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
		const loaded: WebsearchConfig[] = [];
		for (const [index, example] of examples.entries()) {
			const home = join(root, `home-${index}`);
			mkdirSync(join(home, ".senpi"), { recursive: true });
			writeFileSync(join(home, ".senpi", "websearch.json"), example);
			const result = await loadWebsearchConfig({ cwd: join(root, "project"), homeDir: home });
			expect(result, `example ${index + 1}`).toMatchObject({
				ok: true,
				source: join(home, ".senpi", "websearch.json"),
			});
			if (result.ok) loaded.push(result.config);
		}

		const routes = loaded.map(
			(config) => `${config.auto ? "auto " : ""}${config.providers.map(providerEntryLabel).join(",")}`,
		);
		expect(routes).toContain("auto duckduckgo-html");
		expect(routes).toContain("auto searxng,brave");
		expect(routes).toContain("searxng");
	});

	it("keeps an explicit websearch.json in charge: its providers replace the free chain", async () => {
		const home = join(root, "home");
		mkdirSync(join(home, ".senpi"), { recursive: true });
		writeFileSync(
			join(home, ".senpi", "websearch.json"),
			JSON.stringify({ providers: [{ provider: "searxng", baseUrl: "http://localhost:8888" }] }),
		);

		const loaded = await loadWebsearchConfig({ cwd: join(root, "project"), homeDir: home });

		expect(loaded.ok).toBe(true);
		if (loaded.ok) expect(loaded.config.providers.map(providerEntryLabel)).toEqual(["searxng"]);
	});
});

describe("per-engine block and cooldown", () => {
	it("moves on to the next engine when DuckDuckGo serves its anomaly page", async () => {
		const { hosts } = stubEngines({
			"html.duckduckgo.com": ddgChallenged,
			"www.startpage.com": startpageAnswers,
		});

		const details = await performSearch(freeChain(), REQUEST, undefined, createSearchRoutingState(2));

		expect(details.error).toBeUndefined();
		expect(details.provider).toBe("startpage");
		expect(labels(details)).toEqual(["duckduckgo-html:challenge", "startpage:3"]);
		expect(hosts).toEqual(["html.duckduckgo.com", "www.startpage.com", "www.startpage.com"]);
		expect(formatSearchText(details)).toContain("duckduckgo-html challenged: DuckDuckGo served a bot challenge");
	});

	it("skips a cooled-down engine on the next search and names it in the routing attempts line", async () => {
		const state = createSearchRoutingState(2);
		stubEngines({ "html.duckduckgo.com": ddgChallenged, "www.startpage.com": startpageAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);

		const { hosts } = stubEngines({ "www.startpage.com": startpageAnswers });
		const second = await performSearch(freeChain(), REQUEST, undefined, state);

		expect(hosts).not.toContain("html.duckduckgo.com");
		expect(labels(second)).toEqual(["duckduckgo-html:skipped", "startpage:3"]);
		expect(formatSearchText(second)).toMatch(/Routing attempts: duckduckgo-html skipped \(cooling down/);
	});

	it("retries the engine once its cooldown expires and doubles the cooldown on a repeat block", async () => {
		vi.useFakeTimers({ now: new Date("2026-09-29T00:00:00Z"), toFake: ["Date"] });
		const state = createSearchRoutingState(2);
		stubEngines({ "html.duckduckgo.com": ddgChallenged, "www.startpage.com": startpageAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);

		vi.advanceTimersByTime(ENGINE_COOLDOWN_BASE_MS - 1);
		let run = stubEngines({ "www.startpage.com": startpageAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);
		expect(run.hosts).not.toContain("html.duckduckgo.com");

		vi.advanceTimersByTime(1);
		run = stubEngines({ "html.duckduckgo.com": ddgChallenged, "www.startpage.com": startpageAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);
		expect(run.hosts[0]).toBe("html.duckduckgo.com");

		vi.advanceTimersByTime(ENGINE_COOLDOWN_BASE_MS);
		run = stubEngines({ "www.startpage.com": startpageAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);
		expect(run.hosts).not.toContain("html.duckduckgo.com");

		vi.advanceTimersByTime(ENGINE_COOLDOWN_BASE_MS);
		run = stubEngines({ "html.duckduckgo.com": ddgAnswers });
		const recovered = await performSearch(freeChain(), REQUEST, undefined, state);
		expect(recovered.provider).toBe("duckduckgo-html");
		expect(labels(recovered)).toEqual(["duckduckgo-html:3"]);
	});

	it("clears the backoff after a success, so the next block starts from the base cooldown again", async () => {
		vi.useFakeTimers({ now: new Date("2026-09-29T00:00:00Z"), toFake: ["Date"] });
		const state = createSearchRoutingState(2);
		stubEngines({ "html.duckduckgo.com": ddgChallenged, "www.startpage.com": startpageAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);
		vi.advanceTimersByTime(ENGINE_COOLDOWN_BASE_MS);
		stubEngines({ "html.duckduckgo.com": ddgAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);

		stubEngines({ "html.duckduckgo.com": ddgChallenged, "www.startpage.com": startpageAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);
		vi.advanceTimersByTime(ENGINE_COOLDOWN_BASE_MS);
		const run = stubEngines({ "html.duckduckgo.com": ddgAnswers });
		await performSearch(freeChain(), REQUEST, undefined, state);

		expect(run.hosts).toEqual(["html.duckduckgo.com"]);
	});

	it("cools an engine down on 429, 403 and network errors, but not on a server error", async () => {
		const blocked = async (route: Route) => {
			const state = createSearchRoutingState(2);
			stubEngines({ "html.duckduckgo.com": route, "www.startpage.com": startpageAnswers });
			const first = await performSearch(freeChain(), REQUEST, undefined, state);
			const run = stubEngines({ "html.duckduckgo.com": ddgAnswers, "www.startpage.com": startpageAnswers });
			await performSearch(freeChain(), REQUEST, undefined, state);
			return { reason: first.attempts?.[0]?.blocked, retried: run.hosts.includes("html.duckduckgo.com") };
		};

		expect(await blocked(() => html("slow down", 429))).toEqual({ reason: "rate_limited", retried: false });
		expect(await blocked(() => html("forbidden", 403))).toEqual({ reason: "forbidden", retried: false });
		expect(
			await blocked(() => {
				throw new TypeError("fetch failed");
			}),
		).toEqual({ reason: "network", retried: false });
		expect(await blocked(() => html("oops", 500))).toEqual({ reason: undefined, retried: true });
	});

	it("does not cool down a provider that needs a key, so a configured provider keeps its place", async () => {
		const config: WebsearchConfig = {
			strategy: "priority",
			fallback: true,
			auto: false,
			providers: [{ provider: "brave", apiKey: "brave-test" }, { provider: "duckduckgo-html" }],
		};
		const state = createSearchRoutingState(2);
		stubEngines({ "api.search.brave.com": () => html("limit", 429), "html.duckduckgo.com": ddgAnswers });
		await performSearch(config, REQUEST, undefined, state);

		const run = stubEngines({ "api.search.brave.com": () => html("limit", 429), "html.duckduckgo.com": ddgAnswers });
		const second = await performSearch(config, REQUEST, undefined, state);

		expect(run.hosts[0]).toBe("api.search.brave.com");
		expect(second.attempts?.[0]?.skipped).toBeUndefined();
	});

	it("reports every engine as skipped when all of them are cooling down", async () => {
		const state = createSearchRoutingState(2);
		stubEngines({
			"html.duckduckgo.com": ddgChallenged,
			"www.startpage.com": () => html(fixture("startpage-anubis.html")),
		});
		await performSearch(freeChain(), REQUEST, undefined, state);

		const { fetchMock } = stubEngines({});
		const details = await performSearch(freeChain(), REQUEST, undefined, state);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(labels(details)).toEqual(["duckduckgo-html:skipped", "startpage:skipped"]);
		expect(details.error).toMatch(/^All configured search providers failed: duckduckgo-html skipped/);
	});
});

describe("routing strategies over the free engines", () => {
	it("round-robin still rotates the starting engine", async () => {
		const config: WebsearchConfig = { ...freeChain(), strategy: "round-robin" };
		const state = createSearchRoutingState(2);
		stubEngines({ "html.duckduckgo.com": ddgAnswers, "www.startpage.com": startpageAnswers });

		const first = await performSearch(config, REQUEST, undefined, state);
		const second = await performSearch(config, REQUEST, undefined, state);

		expect([first.provider, second.provider]).toEqual(["duckduckgo-html", "startpage"]);
	});

	it("fill-first still merges engines until maxResults and picks the least used engine first", async () => {
		const config: WebsearchConfig = { ...freeChain(), strategy: "fill-first" };
		const state = createSearchRoutingState(2);
		stubEngines({ "html.duckduckgo.com": ddgAnswers, "www.startpage.com": startpageAnswers });

		const merged = await performSearch(config, { ...REQUEST, maxResults: 5 }, undefined, state);

		expect(labels(merged)).toEqual(["duckduckgo-html:3", "startpage:3"]);
		expect(merged.results.length).toBe(5);
		const next = await performSearch(config, { ...REQUEST, maxResults: 5 }, undefined, state);
		expect(next.attempts?.[0]?.provider).toBe("duckduckgo-html");
	});

	it("priority still honours explicit priority values", async () => {
		const config: WebsearchConfig = {
			...freeChain(),
			providers: [
				{ provider: "duckduckgo-html", priority: 2 },
				{ provider: "startpage", priority: 1 },
			],
		};
		stubEngines({ "html.duckduckgo.com": ddgAnswers, "www.startpage.com": startpageAnswers });

		const details = await performSearch(config, REQUEST, undefined, createSearchRoutingState(2));

		expect(details.provider).toBe("startpage");
	});
});

describe("web_search tool keeps cooldowns for the session", () => {
	function context(): ExtensionContext {
		return { model: undefined, modelRegistry: undefined } as unknown as ExtensionContext;
	}

	it("skips a blocked engine on the next call even when the provider list changes between calls", async () => {
		let config = freeChain();
		const tool = createWebSearchTool(() => ({ ok: true, config, source: "test" }));
		stubEngines({ "html.duckduckgo.com": ddgChallenged, "www.startpage.com": startpageAnswers });
		await tool.execute("call-1", { query: REQUEST.query }, undefined, undefined, context() as ExtensionToolContext);

		config = { ...freeChain(), providers: [...freeChain().providers, { provider: "mojeek" }] };
		const { hosts } = stubEngines({ "www.startpage.com": startpageAnswers });
		const result = await tool.execute(
			"call-2",
			{ query: REQUEST.query },
			undefined,
			undefined,
			context() as ExtensionToolContext,
		);

		expect(hosts).not.toContain("html.duckduckgo.com");
		const details = result.details as SearchRenderDetails & SearchDetails;
		expect(labels(details)).toEqual(["duckduckgo-html:skipped", "startpage:3"]);
	});
});
