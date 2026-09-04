import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

// A map-less Astra model exercises the id-based inference in models.ts
// (XHIGH_MODEL_IDS / OPENAI_MAX_MODEL_IDS / OPENAI_MAX_APIS) directly, so
// dropping gpt-6-astra from either list fails these assertions even though the
// generated catalog already ships an explicit thinkingLevelMap.
function maplessAstra(api: Api): Model<Api> {
	return {
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api,
		provider: "custom",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

const EXPECTED_COST = {
	input: 10,
	output: 50,
	cacheRead: 1,
	cacheWrite: 12.5,
	tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
};

for (const provider of ["openai", "openai-codex"] as const) {
	describe(`${provider}/gpt-6-astra`, () => {
		it("has the published catalog metadata and long-context pricing", () => {
			const model = getModel(provider, "gpt-6-astra");
			expect(model).toMatchObject({
				id: "gpt-6-astra",
				name: "GPT-6 Astra",
				api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
				provider,
				baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 272000,
				maxTokens: 128000,
				cost: EXPECTED_COST,
			});
		});

		it("exposes only the supported reasoning efforts", () => {
			const model = getModel(provider, "gpt-6-astra")!;
			expect(model.thinkingLevelMap).toMatchObject({
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			});
			expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
			expect(supportsXhigh(model)).toBe(true);
			expect(supportsMax(model)).toBe(true);
		});

		it("exposes the tool-search and additional-tools metadata", () => {
			const model = getModel(provider, "gpt-6-astra")!;
			const compat = model.compat as { supportsToolSearch?: boolean; supportsAdditionalTools?: boolean } | undefined;
			expect(compat?.supportsToolSearch).toBe(true);
			expect(compat?.supportsAdditionalTools).toBe(true);
		});

		it("has a priority fast variant", () => {
			const fast = getModel(provider, "gpt-6-astra-fast");
			expect(fast).toMatchObject({
				id: "gpt-6-astra-fast",
				upstreamModelId: "gpt-6-astra",
				serviceTier: "priority",
			});
		});
	});
}

describe("gpt-6-astra effort inference without a thinking-level map", () => {
	for (const api of [
		"openai-responses",
		"openai-codex-responses",
		"azure-openai-responses",
		"openai-completions",
	] as const) {
		it(`infers xhigh and max for a map-less gpt-6-astra on ${api}`, () => {
			const model = maplessAstra(api);
			expect(supportsXhigh(model)).toBe(true);
			expect(supportsMax(model)).toBe(true);
		});
	}
});
