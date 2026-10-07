import { describe, expect, it } from "vitest";
import {
	CLAUDE_NPM_DIST_TAG_URL,
	CLAUDE_RELEASE_CHANNEL_URL,
	type ClaudeCodeVersionStore,
	compareClaudeCodeVersions,
	createClaudeCodeVersionResolver,
	fetchLatestClaudeCodeVersion,
	requiredClaudeCodeVersionFromError,
} from "../src/utils/claude-code-version.ts";

type Responses = Partial<Record<string, string | null>>;

const SOURCES_PER_REFRESH = 2;

function fakeFetch(responses: Responses): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const fetchImpl = (async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const body = responses[url];
		return body == null ? new Response("unavailable", { status: 503 }) : new Response(body);
	}) as typeof fetch;
	return { calls, fetch: fetchImpl };
}

function memoryStore(initial?: { version: string; checkedAt: number }): ClaudeCodeVersionStore & {
	writes: Array<{ version: string; checkedAt: number }>;
} {
	let record = initial;
	const writes: Array<{ version: string; checkedAt: number }> = [];
	return {
		writes,
		load: () => record,
		save: (next) => {
			record = next;
			writes.push(next);
		},
	};
}

describe("compareClaudeCodeVersions", () => {
	it("orders by numeric segments, not lexically", () => {
		expect(compareClaudeCodeVersions("2.1.284", "2.1.9")).toBeGreaterThan(0);
		expect(compareClaudeCodeVersions("2.1.284", "2.1.284")).toBe(0);
		expect(compareClaudeCodeVersions("2.0.999", "2.1.0")).toBeLessThan(0);
	});
});

describe("fetchLatestClaudeCodeVersion", () => {
	it("takes the higher of the release channel and the npm dist-tag", async () => {
		const { fetch } = fakeFetch({
			[CLAUDE_RELEASE_CHANNEL_URL]: "2.1.290\n",
			[CLAUDE_NPM_DIST_TAG_URL]: JSON.stringify({ version: "2.1.288" }),
		});
		expect(await fetchLatestClaudeCodeVersion(fetch)).toBe("2.1.290");
	});

	it("uses the surviving source when one fails and returns undefined when both fail", async () => {
		const npmOnly = fakeFetch({ [CLAUDE_NPM_DIST_TAG_URL]: JSON.stringify({ version: "2.1.300" }) });
		expect(await fetchLatestClaudeCodeVersion(npmOnly.fetch)).toBe("2.1.300");
		expect(await fetchLatestClaudeCodeVersion(fakeFetch({}).fetch)).toBeUndefined();
		const throwing = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(await fetchLatestClaudeCodeVersion(throwing)).toBeUndefined();
	});
});

describe("createClaudeCodeVersionResolver", () => {
	it("answers the floor immediately, then the fetched latest after the background refresh, and persists it", async () => {
		const store = memoryStore();
		const { fetch } = fakeFetch({ [CLAUDE_RELEASE_CHANNEL_URL]: "2.1.300" });
		const resolver = createClaudeCodeVersionResolver({ floor: "2.1.284", store, fetch });

		expect(resolver.get()).toBe("2.1.284");
		expect(await resolver.refresh()).toBe("2.1.300");
		expect(resolver.get()).toBe("2.1.300");
		expect(store.writes.at(-1)?.version).toBe("2.1.300");
	});

	it("never answers below the floor when upstream or the cache is older", async () => {
		const store = memoryStore({ version: "2.1.100", checkedAt: Date.now() });
		const { fetch } = fakeFetch({ [CLAUDE_RELEASE_CHANNEL_URL]: "2.1.200" });
		const resolver = createClaudeCodeVersionResolver({ floor: "2.1.284", store, fetch });

		expect(resolver.get()).toBe("2.1.284");
		expect(await resolver.refresh()).toBe("2.1.284");
	});

	it("reuses a fresh cache without touching the network", () => {
		const store = memoryStore({ version: "2.1.299", checkedAt: 1_000 });
		const { fetch, calls } = fakeFetch({});
		const resolver = createClaudeCodeVersionResolver({ floor: "2.1.284", store, fetch, now: () => 2_000 });

		expect(resolver.get()).toBe("2.1.299");
		expect(calls).toEqual([]);
	});

	it("schedules one background refresh for a stale cache and keeps the cached value when the lookup fails", async () => {
		const store = memoryStore({ version: "2.1.299", checkedAt: 0 });
		const { fetch, calls } = fakeFetch({});
		const resolver = createClaudeCodeVersionResolver({
			floor: "2.1.284",
			store,
			fetch,
			now: () => 10_000,
			refreshIntervalMs: 1_000,
		});

		expect(resolver.get()).toBe("2.1.299");
		expect(resolver.get()).toBe("2.1.299");
		expect(await resolver.refresh()).toBe("2.1.299");
		expect(calls.length).toBe(SOURCES_PER_REFRESH);
		expect(resolver.get()).toBe("2.1.299");
		expect(calls.length).toBe(SOURCES_PER_REFRESH);
	});

	it("honors an exact pin, skips the network for it, and ignores a malformed pin", async () => {
		const { fetch, calls } = fakeFetch({ [CLAUDE_RELEASE_CHANNEL_URL]: "2.1.300" });
		const pinned = createClaudeCodeVersionResolver({
			floor: "2.1.284",
			pinned: "2.1.250",
			store: memoryStore(),
			fetch,
		});
		expect(pinned.get()).toBe("2.1.250");
		expect(await pinned.refresh()).toBe("2.1.250");
		expect(calls).toEqual([]);

		const malformed = createClaudeCodeVersionResolver({ floor: "2.1.284", pinned: "latest", store: null, fetch });
		expect(malformed.get()).toBe("2.1.284");
	});

	it("without a store answers the floor and never fetches", async () => {
		const { fetch, calls } = fakeFetch({ [CLAUDE_RELEASE_CHANNEL_URL]: "2.1.300" });
		const resolver = createClaudeCodeVersionResolver({ floor: "2.1.284", store: null, fetch });
		expect(resolver.get()).toBe("2.1.284");
		expect(await resolver.refresh()).toBe("2.1.284");
		expect(calls).toEqual([]);
	});

	it("raise() adopts a newer required version at once and persists it, ignoring older ones", async () => {
		const store = memoryStore();
		const resolver = createClaudeCodeVersionResolver({ floor: "2.1.284", store, fetch: fakeFetch({}).fetch });
		expect(resolver.raise("2.1.290")).toBe("2.1.290");
		expect(resolver.get()).toBe("2.1.290");
		expect(store.writes.at(-1)?.version).toBe("2.1.290");
		expect(resolver.raise("2.1.100")).toBe("2.1.290");
	});
});

describe("requiredClaudeCodeVersionFromError", () => {
	it("reads the version Anthropic names in a claude_code_version_too_old rejection", () => {
		expect(
			requiredClaudeCodeVersionFromError(
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.280 does not support this model; version 2.1.284 or newer is required. Run \'claude update\', or update the Claude desktop app, then try again.","error_code":"claude_code_version_too_old"}}',
			),
		).toBe("2.1.284");
	});

	it("returns undefined for unrelated 400s", () => {
		expect(
			requiredClaudeCodeVersionFromError(
				'400 {"error":{"message":"tool_choice: type \\"tool\\" is not supported"}}',
			),
		).toBeUndefined();
	});
});
