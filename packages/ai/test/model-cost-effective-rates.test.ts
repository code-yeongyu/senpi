import { describe, expect, it } from "vitest";
import { calculateCost } from "../src/models.ts";
import type { Api, Model, ModelCost, Usage } from "../src/types.ts";

const LIST_PRICE_FROM = "2026-12-01T08:00:00Z";
const INTRO_AND_LIST: ModelCost = {
	input: 2,
	output: 10,
	cacheRead: 0.1,
	cacheWrite: 0,
	effectiveRates: [{ effectiveFrom: LIST_PRICE_FROM, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 }],
};

function modelWith(cost: ModelCost): Model<Api> {
	return {
		id: "dated-price-model",
		name: "Dated price model",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

function millionEach(): Usage {
	return {
		input: 1_000_000,
		output: 1_000_000,
		cacheRead: 1_000_000,
		cacheWrite: 0,
		totalTokens: 3_000_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const at = (iso: string) => Date.parse(iso);

describe("dated cost cards (senpi#3378)", () => {
	it("bills the introductory card until the list price starts", () => {
		const cost = calculateCost(modelWith(INTRO_AND_LIST), millionEach(), at("2026-12-01T07:59:59Z"));

		expect(cost).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0, total: 12.1 });
	});

	it("bills the list price from its effective instant on", () => {
		const cost = calculateCost(modelWith(INTRO_AND_LIST), millionEach(), at(LIST_PRICE_FROM));

		expect(cost).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0, total: 24.2 });
	});

	it("picks the latest started card when several are scheduled, in any order", () => {
		const cost: ModelCost = {
			...INTRO_AND_LIST,
			effectiveRates: [
				{ effectiveFrom: "2027-06-01T00:00:00Z", input: 8, output: 40, cacheRead: 0.4, cacheWrite: 0 },
				{ effectiveFrom: LIST_PRICE_FROM, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
			],
		};

		expect(calculateCost(modelWith(cost), millionEach(), at("2027-01-15T00:00:00Z")).input).toBe(4);
		expect(calculateCost(modelWith(cost), millionEach(), at("2027-06-01T00:00:00Z")).input).toBe(8);
	});

	it("applies the started card's own long-context tiers, not the base card's", () => {
		const cost: ModelCost = {
			input: 2,
			output: 10,
			cacheRead: 0.1,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 100, input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 }],
			effectiveRates: [
				{
					effectiveFrom: LIST_PRICE_FROM,
					input: 4,
					output: 20,
					cacheRead: 0.2,
					cacheWrite: 0,
					tiers: [{ inputTokensAbove: 100, input: 6, output: 30, cacheRead: 0.3, cacheWrite: 0 }],
				},
			],
		};

		expect(calculateCost(modelWith(cost), millionEach(), at("2026-11-30T00:00:00Z")).input).toBe(3);
		expect(calculateCost(modelWith(cost), millionEach(), at(LIST_PRICE_FROM)).input).toBe(6);
	});
});
