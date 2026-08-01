import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadWebsearchConfig } from "../src/core/extensions/builtin/websearch/websearch/config.ts";
import { defaultProviderUrl } from "../src/core/extensions/builtin/websearch/websearch/provider-endpoints.ts";
import {
	buildSearchRequest,
	normalizeSearchResponse,
} from "../src/core/extensions/builtin/websearch/websearch/providers.ts";

const tempDirs: string[] = [];

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "websearch-deepseek-anthropic-response.json");

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function loadConfigWithProvider(provider: string, apiKey?: string) {
	const cwd = await makeTempDir("websearch-deepseek-");
	const home = await makeTempDir("websearch-deepseek-home-");
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	const entry: Record<string, unknown> = { provider };
	if (apiKey !== undefined) entry.apiKey = apiKey;
	await writeFile(join(cwd, ".senpi", "websearch.json"), JSON.stringify({ auto: false, providers: [entry] }));
	return loadWebsearchConfig({ cwd, homeDir: home });
}

describe("vendored websearch deepseek provider", () => {
	it("#given a deepseek provider with an api key #when loading the config #then accepts it", async () => {
		// when
		const result = await loadConfigWithProvider("deepseek", "test-key");

		// then
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.providers[0]?.provider).toBe("deepseek");
		}
	});

	it("#given a deepseek provider without an api key #when loading the config #then rejects with missing_api_key", async () => {
		// when
		const result = await loadConfigWithProvider("deepseek");

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("missing_api_key");
		}
	});

	it("#given a deepseek provider #when resolving the default endpoint #then uses the official Anthropic-compatible route", () => {
		// when
		const url = defaultProviderUrl("deepseek");

		// then
		expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
	});

	it("#given a deepseek search request #when building the request #then posts a web_search_20250305 tool call with the default model", () => {
		// when
		const built = buildSearchRequest(
			{ provider: "deepseek", apiKey: "test-key" },
			{ query: "rust release notes", maxResults: 5 },
		);

		// then
		expect(built.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
		expect(built.init.method).toBe("POST");
		expect(built.init.headers["x-api-key"]).toBe("test-key");
		expect(built.init.headers["anthropic-version"]).toBe("2023-06-01");
		expect(built.body).toEqual({
			model: "deepseek-v4-flash",
			max_tokens: 1024,
			messages: [{ role: "user", content: "rust release notes" }],
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
		});
	});

	it("#given a configured model and allowed domains #when building the request #then the model override and domain filter win", () => {
		// when
		const built = buildSearchRequest(
			{ provider: "deepseek", apiKey: "test-key", model: "deepseek-v4-pro", allowedDomains: ["rust-lang.org"] },
			{ query: "rust release notes", maxResults: 5 },
		);

		// then
		expect(built.body?.model).toBe("deepseek-v4-pro");
		expect(built.body?.tools).toEqual([
			{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["rust-lang.org"] },
		]);
	});

	it("#given a live DeepSeek web_search_tool_result payload #when normalizing #then returns titled results", async () => {
		// given
		const payload = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Record<string, unknown>;

		// when
		const results = normalizeSearchResponse("deepseek", payload);

		// then
		expect(results.length).toBeGreaterThan(0);
		for (const item of results) {
			expect(item.title).toBeTruthy();
			expect(item.url).toMatch(/^https?:\/\//);
		}
	});
});
