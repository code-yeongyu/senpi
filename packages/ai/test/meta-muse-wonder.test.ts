import { describe, expect, it } from "vitest";
import { getModel, getModels, getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/compat.ts";

/**
 * Muse Wonder family (Meta, 2026-10-12). `muse-wonder-1.0` is the Meta
 * Model API model at $4.00 input / $0.20 cached input / $20.00 output per
 * MTok; `muse-wonder-full-1.0` is subscription-only (Muse) with no
 * published per-token rate, so the catalog preserves Wonder's base rates
 * until Meta publishes Full pricing. The `-contributor` rows mirror the
 * Muse Spark contributor program rates ($0.10 / $0.002 / $0.20) until Meta
 * publishes Wonder contributor pricing. All four share the 1,048,576-token
 * window, 131,072 output tokens, text + image input, and the
 * minimal..max reasoning ladder from models.dev / the Muse catalog.
 * Retention: generated-catalog contract — a scoped regeneration that drops
 * the synthesized Full/contributor rows or ships Wonder at $0 fails here.
 */
const EXPECTED = {
	"muse-wonder-1.0": {
		name: "Muse Wonder",
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	},
	"muse-wonder-1.0-contributor": {
		name: "Muse Wonder Contributor",
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
	},
	"muse-wonder-full-1.0": {
		name: "Muse Wonder Full",
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	},
	"muse-wonder-full-1.0-contributor": {
		name: "Muse Wonder Full Contributor",
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
	},
} as const;

type WonderId = keyof typeof EXPECTED;
const WONDER_IDS = Object.keys(EXPECTED) as WonderId[];

for (const id of WONDER_IDS) {
	describe(`meta/${id}`, () => {
		it("has the published catalog metadata", () => {
			const model = getModel("meta", id);
			expect(model).toMatchObject({
				id,
				name: EXPECTED[id].name,
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1048576,
				maxTokens: 131072,
				cost: EXPECTED[id].cost,
			});
		});

		it("exposes the minimal..max reasoning ladder", () => {
			const model = getModel("meta", id)!;
			expect(model.thinkingLevelMap).toMatchObject({
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			});
			expect(getSupportedThinkingLevels(model)).toEqual(
				expect.arrayContaining(["minimal", "low", "medium", "high", "xhigh", "max"]),
			);
			expect(supportsXhigh(model)).toBe(true);
			expect(supportsMax(model)).toBe(true);
		});
	});
}

describe("meta catalog", () => {
	it("keeps the Muse Spark rows alongside Wonder", () => {
		const ids = getModels("meta").map((model) => model.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"muse-spark-1.1",
				"muse-spark-1.2",
				"muse-spark-1.2-contributor",
				"muse-spark-1.3",
				"muse-spark-1.3-contributor",
				...WONDER_IDS,
			]),
		);
	});
});
