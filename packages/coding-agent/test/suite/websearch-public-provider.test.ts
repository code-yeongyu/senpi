import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	KEYLESS_PROVIDERS,
	loadWebsearchConfig,
	validateProviderConfig,
} from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	PUBLIC_ENGINES,
	PUBLIC_HARD_DEADLINE_MS,
	PUBLIC_SOFT_DEADLINE_MS,
	type PublicDeadlineWait,
	type PublicEngineSearch,
	publicDedupeKey,
	searchPublicWeb,
} from "../../src/core/extensions/builtin/websearch/websearch/providers/public.ts";
import { performSearch } from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type {
	SearchDetails,
	SearchProvider,
	SearchRequest,
	SearchResultItem,
	WebsearchConfig,
} from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

// Port of oh-my-pi's Public Web aggregate (packages/coding-agent/src/web/search/providers/public.ts), senpi#5485.

const REQUEST: SearchRequest = { query: "typescript satisfies operator", maxResults: 10 };
const PUBLIC_CONFIG: WebsearchConfig = {
	strategy: "priority",
	fallback: true,
	auto: false,
	providers: [{ provider: "public" }],
};

function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", name), "utf8");
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubEngineFetch(calls: string[]): void {
	const pages: Array<[string, string]> = [
		["https://www.startpage.com/sp/search", "startpage-results.html"],
		["https://www.startpage.com/", "startpage-home.html"],
		["https://www.google.com/", "google-results.html"],
		["https://html.duckduckgo.com/", "duckduckgo-results.html"],
		["https://www.ecosia.org/", "ecosia-results.html"],
		["https://www.mojeek.com/", "mojeek-results.html"],
	];
	const stub = async (input: string | URL | Request): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push(url);
		const match = pages.find(([prefix]) => url.startsWith(prefix));
		if (!match) return new Response("unexpected request", { status: 500 });
		return new Response(fixture(match[1]), { headers: { "Content-Type": "text/html; charset=utf-8" } });
	};
	globalThis.fetch = stub as typeof fetch;
}

interface PendingWait {
	ms: number;
	resolve: () => void;
}

function fakeClock(): { wait: PublicDeadlineWait; fire: (ms: number) => void; pending: () => number[] } {
	const waits: PendingWait[] = [];
	return {
		wait: (ms, signal) =>
			new Promise<void>((resolve) => {
				const entry = { ms, resolve };
				waits.push(entry);
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
		fire: (ms) => {
			for (const entry of waits.filter((candidate) => candidate.ms === ms)) entry.resolve();
		},
		pending: () => waits.map((entry) => entry.ms),
	};
}

interface ControlledEngine {
	signal?: AbortSignal;
	answer: (details: Partial<SearchDetails>) => void;
}

function controlledEngines(): { search: PublicEngineSearch; engines: Map<SearchProvider, ControlledEngine> } {
	const engines = new Map<SearchProvider, ControlledEngine>();
	const search: PublicEngineSearch = (entry, request, signal) =>
		new Promise<SearchDetails>((resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			engines.set(entry.provider, {
				signal,
				answer: (details) =>
					resolve({
						provider: entry.provider,
						query: request.query,
						results: [],
						durationMs: 1,
						truncated: false,
						...details,
					}),
			});
		});
	return { search, engines };
}

function item(url: string, title = url, snippet?: string): SearchResultItem {
	return snippet ? { title, url, snippet } : { title, url };
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("public provider configuration", () => {
	it("is a keyless provider that is never part of the no-config default chain", async () => {
		expect(KEYLESS_PROVIDERS.has("public")).toBe(true);
		expect(validateProviderConfig({ provider: "public" }).ok).toBe(true);
		expect(validateProviderConfig({ provider: "public", baseUrl: "https://search.example.com" }).ok).toBe(false);

		const empty = mkdtempSync(join(tmpdir(), "websearch-public-"));
		const loaded = await loadWebsearchConfig({ cwd: empty, homeDir: empty });
		expect(loaded.ok && loaded.source).toBe("default:free-engines");
		if (loaded.ok) expect(loaded.config.providers.map((entry) => entry.provider)).not.toContain("public");
	});
});

describe("public provider fan-out over the recorded engine pages", () => {
	it("queries every keyless engine once and ranks merged URLs by engine count, then best rank", async () => {
		const calls: string[] = [];
		stubEngineFetch(calls);

		const details = await performSearch(PUBLIC_CONFIG, REQUEST);

		expect(details.error).toBeUndefined();
		expect(details.provider).toBe("public");
		expect(details.attempts?.map((attempt) => attempt.provider)).toEqual(["public"]);
		expect(calls.map((url) => new URL(url).host).sort()).toEqual([
			"html.duckduckgo.com",
			"www.ecosia.org",
			"www.google.com",
			"www.mojeek.com",
			"www.startpage.com",
			"www.startpage.com",
		]);
		expect(details.results.map((result) => result.url)).toEqual([
			// Four engines.
			"https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
			// Two engines each; Ecosia ranked velog first, Google ranked the Stack Overflow answer second.
			"https://velog.io/@keumky1/Typescript-satisfiesOperator%EB%8A%94-%EB%AC%B4%EC%97%87%EC%9D%BC%EA%B9%8C",
			"https://stackoverflow.com/questions/78636946/what-are-the-differences-between-typescript-s-satisfies-operator-and-type-assert",
			// One engine each, by per-engine rank, then by engine order.
			"https://schpet.com/linklog/typescript-satisfies-operator",
			"https://www.learningtypescript.com/articles/the-satisfies-operator",
			"https://www.freecodecamp.org/news/typescript-satisfies-operator/",
			"https://www.xjavascript.com/blog/satisfies-typescript/",
			"https://www.zerocho.com/category/TypeScript/post/638c327844d418915ee64b0b",
			"https://stackoverflow.com/questions/73909490/new-typescript-satisfies-operator",
		]);
		// DuckDuckGo's snippet for the shared top URL is the longest of the four engines that returned it.
		expect(details.results[0]?.snippet?.length).toBe(235);
	});

	it("cuts the merged list to the requested count", async () => {
		stubEngineFetch([]);

		const details = await performSearch(PUBLIC_CONFIG, { ...REQUEST, maxResults: 2 });

		expect(details.results).toHaveLength(2);
		expect(details.truncated).toBe(true);
	});
});

describe("public provider merge", () => {
	it("dedupes on host without www, trailing slash and fragment, but keeps the query", () => {
		expect(publicDedupeKey("https://www.Example.com/docs/#intro")).toBe("example.com/docs");
		expect(publicDedupeKey("http://example.com/docs")).toBe("example.com/docs");
		expect(publicDedupeKey("https://example.com/docs?page=2")).toBe("example.com/docs?page=2");
		expect(publicDedupeKey("https://example.com/")).toBe("example.com/");
		expect(publicDedupeKey("not a url")).toBe("not a url");
	});

	it("takes title and URL from the best-ranked copy and the longest snippet from any copy", async () => {
		const clock = fakeClock();
		const { search, engines } = controlledEngines();
		const pending = searchPublicWeb({ provider: "public" }, REQUEST, undefined, search, clock.wait);
		await settle();

		engines.get("startpage")?.answer({
			results: [item("https://other.example/"), item("https://www.example.com/a/", "Late title", "short")],
		});
		engines.get("google-html")?.answer({
			results: [item("https://example.com/a#top", "Top title", "x"), item("https://example.com/a?x=1")],
		});
		engines
			.get("duckduckgo-html")
			?.answer({ results: [item("https://example.com/a", "Third", "the longest snippet")] });
		engines.get("ecosia")?.answer({ error: "Ecosia served a bot challenge" });
		engines.get("mojeek")?.answer({ error: "Mojeek served a bot challenge" });
		const details = await pending;

		expect(details.results).toEqual([
			{ title: "Top title", url: "https://example.com/a#top", snippet: "the longest snippet" },
			item("https://other.example/"),
			item("https://example.com/a?x=1"),
		]);
		expect(clock.pending()).toEqual([PUBLIC_SOFT_DEADLINE_MS]);
	});
});

describe("public provider deadlines", () => {
	it("answers at the soft deadline with the engines that answered and aborts the rest", async () => {
		const clock = fakeClock();
		const { search, engines } = controlledEngines();
		let done = false;
		const pending = searchPublicWeb({ provider: "public" }, REQUEST, undefined, search, clock.wait).then(
			(details) => {
				done = true;
				return details;
			},
		);
		await settle();
		engines.get("duckduckgo-html")?.answer({ results: [item("https://a.example/")] });
		engines.get("mojeek")?.answer({ results: [item("https://b.example/")] });
		await settle();
		expect(done).toBe(false);

		clock.fire(PUBLIC_SOFT_DEADLINE_MS);
		const details = await pending;

		expect(details.error).toBeUndefined();
		expect(details.results.map((result) => result.url)).toEqual(["https://a.example/", "https://b.example/"]);
		for (const provider of ["startpage", "google-html", "ecosia"] as const) {
			expect(engines.get(provider)?.signal?.aborted).toBe(true);
		}
	});

	it("keeps waiting past the soft deadline until the first engine answers", async () => {
		const clock = fakeClock();
		const { search, engines } = controlledEngines();
		const pending = searchPublicWeb({ provider: "public" }, REQUEST, undefined, search, clock.wait);
		await settle();

		clock.fire(PUBLIC_SOFT_DEADLINE_MS);
		await settle();
		expect(clock.pending()).toContain(PUBLIC_HARD_DEADLINE_MS - PUBLIC_SOFT_DEADLINE_MS);
		engines.get("ecosia")?.answer({ results: [item("https://late.example/")] });
		const details = await pending;

		expect(details.results.map((result) => result.url)).toEqual(["https://late.example/"]);
		expect(engines.get("startpage")?.signal?.aborted).toBe(true);
	});

	it("gives up at the hard deadline when no engine answered", async () => {
		const clock = fakeClock();
		const { search, engines } = controlledEngines();
		const pending = searchPublicWeb({ provider: "public" }, REQUEST, undefined, search, clock.wait);
		await settle();

		clock.fire(PUBLIC_SOFT_DEADLINE_MS);
		await settle();
		clock.fire(PUBLIC_HARD_DEADLINE_MS - PUBLIC_SOFT_DEADLINE_MS);
		const details = await pending;

		expect(details.results).toEqual([]);
		expect(details.error).toContain("every engine failed");
		for (const provider of PUBLIC_ENGINES) {
			expect(details.error).toContain(`${provider}: no answer within`);
			expect(engines.get(provider)?.signal?.aborted).toBe(true);
		}
	});

	it("fails without waiting for a deadline when every engine fails", async () => {
		const clock = fakeClock();
		const { search, engines } = controlledEngines();
		const pending = searchPublicWeb({ provider: "public" }, REQUEST, undefined, search, clock.wait);
		await settle();

		for (const provider of PUBLIC_ENGINES) engines.get(provider)?.answer({ error: `${provider} blocked` });
		const details = await pending;

		expect(details.provider).toBe("public");
		expect(details.error).toBe(
			`Search provider public failed: every engine failed (${PUBLIC_ENGINES.map((provider) => `${provider}: ${provider} blocked`).join("; ")})`,
		);
	});

	it("rejects with the caller's abort reason", async () => {
		const clock = fakeClock();
		const { search, engines } = controlledEngines();
		const controller = new AbortController();
		const pending = searchPublicWeb({ provider: "public" }, REQUEST, controller.signal, search, clock.wait);
		await settle();

		controller.abort(new Error("user cancelled"));

		await expect(pending).rejects.toThrow("user cancelled");
		expect(engines.get("startpage")?.signal?.aborted).toBe(true);
	});
});
