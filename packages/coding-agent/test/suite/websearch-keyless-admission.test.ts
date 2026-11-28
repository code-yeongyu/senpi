import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createKeylessAdmission,
	ENGINE_COOLDOWN_BASE_MS,
	KEYLESS_MAX_IN_FLIGHT,
} from "../../src/core/extensions/builtin/websearch/websearch/keyless-admission.ts";
import {
	createSearchRoutingState,
	performSearch,
} from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import { createWebSearchTool } from "../../src/core/extensions/builtin/websearch/websearch/tool.ts";
import type { WebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/types.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../src/core/extensions/types.ts";

function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "fixtures", "websearch", name), "utf8");
}

const REQUEST = { query: "shared anonymous capacity", maxResults: 10 };
const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

function stubEngines(routes: Record<string, (url: string) => Response>) {
	const hosts: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			const host = new URL(url).hostname;
			hosts.push(host);
			const route = routes[host];
			if (!route) throw new Error(`unexpected request to ${url}`);
			return route(url);
		}),
	);
	return { hosts };
}

const ddgChallenged = () => html(fixture("duckduckgo-anomaly.html"), 202);

function config(id: string): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: false,
		providers: [
			{ provider: "duckduckgo-html", id },
			{ provider: "startpage", id },
		],
	};
}

function context(): ExtensionContext {
	return { cwd: "/test-project", model: undefined, modelRegistry: undefined } as unknown as ExtensionContext;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// senpi#4178: distinct tools (each with its own routing state) share one admission, so a block one of them
// recorded skips the engine for the others instead of letting them burst at it independently.
describe("shared keyless admission", () => {
	it("a cooldown recorded through one tool's state skips the engine for another tool", async () => {
		const shared = createKeylessAdmission();
		stubEngines({ "html.duckduckgo.com": ddgChallenged, "www.startpage.com": () => html("{}") });
		await performSearch(config("share-a"), REQUEST, undefined, createSearchRoutingState(2, shared));

		const { hosts } = stubEngines({ "html.duckduckgo.com": () => html(fixture("duckduckgo-results.html")) });
		const second = await performSearch(
			config("share-a"),
			REQUEST,
			undefined,
			createSearchRoutingState(2, shared),
		);

		expect(hosts).not.toContain("html.duckduckgo.com");
		expect(second.attempts?.[0]?.skipped).toBe(true);
	});

	it(`holds at most ${KEYLESS_MAX_IN_FLIGHT} in-flight acquisitions per engine and wakes the next on release`, async () => {
		const shared = createKeylessAdmission();
		const first = await shared.acquire("engine");
		const second = await shared.acquire("engine");
		let admitted = false;
		const third = shared.acquire("engine").then(() => {
			admitted = true;
			return true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(admitted).toBe(false);
		first();
		expect(await third).toBe(true);
		second();
	});

	it("rejects a caller that aborts while waiting for a slot", async () => {
		const shared = createKeylessAdmission();
		const heldA = await shared.acquire("engine");
		const heldB = await shared.acquire("engine");
		const controller = new AbortController();
		const queued = shared.acquire("engine", controller.signal);
		controller.abort();
		await expect(queued).rejects.toThrow();
		heldA();
		heldB();
		const release = await shared.acquire("engine");
		expect(typeof release).toBe("function");
		release();
	});

	it("keeps a cooldown per engine key and clears it on success", () => {
		const admission = createKeylessAdmission();
		const now = Date.now();
		admission.record("engine-a", { kind: "blocked", reason: "rate_limited", retryAfterSeconds: 30 }, now);
		expect(admission.cooldown("engine-a", now)?.reason).toBe("rate_limited");
		expect(admission.cooldown("engine-a", now + ENGINE_COOLDOWN_BASE_MS - 1)?.failures).toBe(1);
		expect(admission.cooldown("engine-a", now + ENGINE_COOLDOWN_BASE_MS + 1)).toBeUndefined();
		expect(admission.cooldown("engine-b", now)).toBeUndefined();
		admission.record("engine-a", { kind: "blocked", reason: "rate_limited" }, now);
		expect(admission.cooldown("engine-a", now)?.failures).toBe(2);
		admission.record("engine-a", { kind: "success" }, now);
		expect(admission.cooldown("engine-a", now)).toBeUndefined();
	});

	it("a tool whose keyless routes are all blocked tells the user how to configure a keyed provider", async () => {
		const tool = createWebSearchTool(() => ({ ok: true, config: config("share-d"), source: "test" }));
		stubEngines({
			"html.duckduckgo.com": ddgChallenged,
			"www.startpage.com": () => html("<html><body>refused</body></html>", 403),
		});

		const result = await tool.execute(
			"call-1",
			{ query: REQUEST.query },
			undefined,
			undefined,
			context() as ExtensionToolContext,
		);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("blocked or rate-limited");
		expect(text).toContain("/test-project/.senpi/websearch.json");
		expect(text).toContain("SearXNG");
	});
});
