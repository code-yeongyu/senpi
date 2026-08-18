import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";

/**
 * `-fast` catalog variants mirror OpenAI Priority processing: same upstream model,
 * `serviceTier: "priority"` requested by default. Eligibility follows the OpenAI
 * pricing page "Priority pricing" table (2026-07); entries keep base cost rates
 * because the openai-responses adapter applies the service-tier cost multiplier
 * at usage-accounting time (doubling here would double-count).
 */
const PRIORITY_TIER_MODEL_IDS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-mini",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-4o",
	"gpt-4o-2024-05-13",
	"gpt-4o-mini",
	"o3",
	"o4-mini",
] as const;

const OPENAI_CODEX_PRIORITY_TIER_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
const GPT_56_SOL_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-sol-fast"] as const;

const NON_PRIORITY_MODEL_IDS = [
	"gpt-5-pro",
	"gpt-5.2-pro",
	"gpt-5.4-pro",
	"gpt-5.5-pro",
	"gpt-5.4-nano",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"gpt-5-chat-latest",
	"gpt-5.2-chat-latest",
	"gpt-5.3-chat-latest",
	"o1",
	"o1-pro",
	"o3-mini",
	"o3-pro",
	"gpt-realtime-2.1",
] as const;

describe("OpenAI -fast priority-tier catalog variants", () => {
	it("defaults GPT-5.6 Sol variants to a 400k context window", () => {
		for (const provider of ["openai", "openai-codex"] as const) {
			for (const id of GPT_56_SOL_MODEL_IDS) {
				const model = getModel(provider, id);
				expect(model, `${provider}/${id} should exist`).toBeDefined();
				expect(model!.contextWindow, `${provider}/${id}`).toBe(400_000);
			}
		}
	});

	it("ships a -fast variant for every priority-eligible model in the catalog", () => {
		const catalogIds = getModels("openai").map((model) => model.id);
		for (const id of PRIORITY_TIER_MODEL_IDS) {
			expect(catalogIds, `base model ${id} should exist`).toContain(id);
			expect(catalogIds, `${id}-fast should exist`).toContain(`${id}-fast`);
		}
	});

	it("clones the base model with upstreamModelId, priority tier, and base cost rates", () => {
		for (const id of PRIORITY_TIER_MODEL_IDS) {
			const base = getModel("openai", id);
			const fast = getModel("openai", `${id}-fast`);
			expect(base, `${id} should exist`).toBeDefined();
			expect(fast, `${id}-fast should exist`).toBeDefined();
			expect(fast!.name).toBe(`${base!.name} Fast`);
			expect(fast!.upstreamModelId).toBe(id);
			expect(fast!.serviceTier).toBe("priority");
			expect(fast!.api).toBe(base!.api);
			expect(fast!.provider).toBe("openai");
			expect(fast!.baseUrl).toBe(base!.baseUrl);
			expect(fast!.reasoning).toBe(base!.reasoning);
			expect(fast!.input).toEqual(base!.input);
			expect(fast!.contextWindow).toBe(base!.contextWindow);
			expect(fast!.maxTokens).toBe(base!.maxTokens);
			expect(fast!.thinkingLevelMap).toEqual(base!.thinkingLevelMap);
			expect(fast!.compat).toEqual(base!.compat);
			expect(fast!.cost).toEqual(base!.cost);
		}
	});

	it("does not ship -fast variants for models without priority processing", () => {
		const catalogIds = getModels("openai").map((model) => model.id);
		for (const id of NON_PRIORITY_MODEL_IDS) {
			expect(catalogIds, `${id}-fast must not exist`).not.toContain(`${id}-fast`);
		}
	});

	it("does not recurse (-fast-fast) and keeps variants out of azure", () => {
		const catalogIds = getModels("openai").map((model) => model.id);
		expect(catalogIds.some((id) => id.endsWith("-fast-fast"))).toBe(false);
		expect(getModels("azure-openai-responses").some((model) => model.id.endsWith("-fast"))).toBe(false);
	});

	it("ships a -fast variant for openai-codex priority-eligible models", () => {
		const codexCatalogIds = getModels("openai-codex").map((model) => model.id);
		for (const id of OPENAI_CODEX_PRIORITY_TIER_MODEL_IDS) {
			expect(codexCatalogIds, `codex base model ${id} should exist`).toContain(id);
			expect(codexCatalogIds, `codex ${id}-fast should exist`).toContain(`${id}-fast`);
		}
	});

	it("clones the codex base model with upstreamModelId, priority tier, and base cost rates", () => {
		for (const id of OPENAI_CODEX_PRIORITY_TIER_MODEL_IDS) {
			const base = getModel("openai-codex", id);
			const fast = getModel("openai-codex", `${id}-fast`);
			expect(base, `${id} should exist`).toBeDefined();
			expect(fast, `${id}-fast should exist`).toBeDefined();
			expect(fast!.name).toBe(`${base!.name} Fast`);
			expect(fast!.upstreamModelId).toBe(id);
			expect(fast!.serviceTier).toBe("priority");
			expect(fast!.api).toBe(base!.api);
			expect(fast!.provider).toBe("openai-codex");
			expect(fast!.baseUrl).toBe(base!.baseUrl);
			expect(fast!.reasoning).toBe(base!.reasoning);
			expect(fast!.input).toEqual(base!.input);
			expect(fast!.contextWindow).toBe(base!.contextWindow);
			expect(fast!.maxTokens).toBe(base!.maxTokens);
			expect(fast!.thinkingLevelMap).toEqual(base!.thinkingLevelMap);
			expect(fast!.compat).toEqual(base!.compat);
			expect(fast!.cost).toEqual(base!.cost);
		}
	});
});
