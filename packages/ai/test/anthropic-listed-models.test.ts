import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { fetchAnthropicModelIds, listedAnthropicModels } from "../src/providers/anthropic-listed-models.ts";

const CATALOG = Object.values(ANTHROPIC_MODELS);
const FABLE_5_2 = ANTHROPIC_MODELS["claude-fable-5-2"];

function stubListing(...pages: Array<{ ids: string[]; hasMore?: boolean } | { status: number }>): Request[] {
	const requests: Request[] = [];
	const responses = [...pages];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests.push(new Request(input, init));
		const page = responses.shift();
		if (!page) throw new Error("unexpected model list request");
		if ("status" in page) return new Response("{}", { status: page.status });
		const data = page.ids.map((id) => ({ type: "model", id, display_name: id }));
		return Response.json({ data, has_more: page.hasMore === true, last_id: page.ids.at(-1) ?? null });
	});
	return requests;
}

describe("listedAnthropicModels", () => {
	it("derives a listed Mythos release from the Fable row of the same version", () => {
		const models = listedAnthropicModels(CATALOG, ["claude-mythos-5-2", "claude-fable-5-2", "claude-mythos-5-1"]);

		expect(models.map((model) => model.id)).toEqual(["claude-mythos-5-2", "claude-fable-5-2", "claude-mythos-5-1"]);
		const { allowedFallbackModels, ...fableCompat } = FABLE_5_2.compat ?? {};
		expect(allowedFallbackModels?.length).toBeGreaterThan(0);
		expect(models[0]).toEqual({
			...FABLE_5_2,
			id: "claude-mythos-5-2",
			name: "Claude Mythos 5.2",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknown: true },
			compat: fableCompat,
		});
		expect(models[1]).toBe(FABLE_5_2);
		expect(models[2]).toMatchObject({
			name: "Claude Mythos 5.1",
			contextWindow: ANTHROPIC_MODELS["claude-fable-5-1"].contextWindow,
			maxTokens: ANTHROPIC_MODELS["claude-fable-5-1"].maxTokens,
			thinkingLevelMap: ANTHROPIC_MODELS["claude-fable-5-1"].thinkingLevelMap,
		});
	});

	it("drops listed ids that have no catalogued sibling", () => {
		const models = listedAnthropicModels(CATALOG, ["claude-mythos-5-9", "claude-mythos-6", "claude-nova-1"]);

		expect(models).toEqual([]);
	});
});

describe("fetchAnthropicModelIds", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("follows every page of the account's listing with the given credential headers", async () => {
		const requests = stubListing(
			{ ids: ["claude-mythos-5-2", "claude-fable-5-2"], hasMore: true },
			{ ids: ["claude-mythos-5-1", "claude-opus-5"] },
		);

		const ids = await fetchAnthropicModelIds({ authorization: "Bearer test" }, new AbortController().signal);

		expect(ids).toEqual(["claude-mythos-5-2", "claude-fable-5-2", "claude-mythos-5-1", "claude-opus-5"]);
		expect(requests.map((request) => request.url)).toEqual([
			"https://api.anthropic.com/v1/models?limit=1000",
			"https://api.anthropic.com/v1/models?limit=1000&after_id=claude-fable-5-2",
		]);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer test");
		expect(requests[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
	});

	it("lists nothing for a credential the endpoint refuses", async () => {
		stubListing({ status: 403 });

		await expect(fetchAnthropicModelIds({ "x-api-key": "k" }, new AbortController().signal)).resolves.toEqual([]);
	});

	it("throws on any other failure so the caller keeps its last catalog", async () => {
		stubListing({ status: 500 });

		await expect(fetchAnthropicModelIds({ "x-api-key": "k" }, new AbortController().signal)).rejects.toThrow(
			"Could not list Anthropic models: 500",
		);
	});
});
