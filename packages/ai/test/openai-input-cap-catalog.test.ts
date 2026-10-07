import { describe, expect, it } from "vitest";
import { type BuiltinProvider, getBuiltinModels, getBuiltinProviders } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

// Issue #1422: OpenAI budgets input and output separately, so a GPT-5.x/GPT-6
// row must carry the prompt budget (272,000 for the 400,000 tier, 922,000 for
// the 1,050,000 tier), whichever provider serves the model.

const GATEWAY_PREFIX = /^(?:[a-z]{2}\.)?(?:global\.)?openai[./]/;
const DOCUMENTED_TOTALS = new Map([
	[400_000, 272_000],
	[1_050_000, 922_000],
]);
// GPT-6 Sol and GPT-6.1 Sol document a 1,050,000 window; their project prompt budget is 400,000, which
// happens to equal the 400,000-tier total. Only those exact pairings are a deliberate budget rather than
// an uncapped row.
const DELIBERATE_TIER_BUDGETS = new Map([
	["gpt-6-sol", 400_000],
	["gpt-6.1-sol", 400_000],
	// Venice spells the point release without the dot (openai-gpt-61-sol).
	["gpt-61-sol", 400_000],
]);

function isFlagshipFamily(id: string): boolean {
	const bare = id.replace(GATEWAY_PREFIX, "");
	return /^gpt-(?:5|6)(?:[.-]|$)/.test(bare) && !bare.startsWith("gpt-oss");
}

function isDeliberateTierBudget(model: Model<Api>): boolean {
	for (const [marker, contextWindow] of DELIBERATE_TIER_BUDGETS) {
		if (model.id.includes(marker) && model.contextWindow === contextWindow) return true;
	}
	return false;
}

function flagshipRows(): Array<{ provider: BuiltinProvider; model: Model<Api> }> {
	return getBuiltinProviders().flatMap((provider) =>
		getBuiltinModels(provider)
			.filter((model) => isFlagshipFamily(model.id) && model.maxTokens === 128_000)
			.map((model) => ({ provider, model })),
	);
}

describe("OpenAI flagship catalog rows store the input cap", () => {
	it("never carries a documented total window as contextWindow on any provider", () => {
		//#given
		const rows = flagshipRows();
		expect(rows.length).toBeGreaterThan(20);

		//#when
		const offenders = rows
			.filter(({ model }) => DOCUMENTED_TOTALS.has(model.contextWindow) && !isDeliberateTierBudget(model))
			.map(({ provider, model }) => `${provider}/${model.id}=${model.contextWindow}`);

		//#then
		expect(offenders).toEqual([]);
	});

	it.each([
		["vercel-ai-gateway", "openai/gpt-5.6-luna", 922_000],
		["vercel-ai-gateway", "openai/gpt-6-astra", 600_000],
		["opengateway", "openai/gpt-5.6-luna", 922_000],
		["opengateway", "openai/gpt-5.6-sol", 922_000],
		["amazon-bedrock", "openai.gpt-5.6-luna", 922_000],
		["amazon-bedrock", "global.openai.gpt-5.6-terra", 922_000],
		["openrouter", "openai/gpt-6-astra", 600_000],
		["openrouter", "openai/gpt-6-sol", 400_000],
		["openrouter", "openai/gpt-6.1-sol", 400_000],
		["openrouter", "openai/gpt-6-luna", 922_000],
		["vercel-ai-gateway", "openai/gpt-6-sol-fast", 400_000],
		["vercel-ai-gateway", "openai/gpt-6.1-sol-fast", 400_000],
		["venice", "openai-gpt-61-sol", 400_000],
		["opencode", "gpt-6.1-sol", 400_000],
		["github-copilot", "gpt-6.1-sol", 400_000],
		["openai", "gpt-5-pro", 272_000],
		["azure-openai-responses", "gpt-5-pro", 272_000],
	] as const)("%s/%s resolves to %i", (provider: BuiltinProvider, id: string, contextWindow: number) => {
		const model = getBuiltinModels(provider).find((candidate) => candidate.id === id);
		expect(model, `${provider}/${id} should exist`).toBeDefined();
		expect(model?.contextWindow).toBe(contextWindow);
		expect(model?.maxTokens).toBe(128_000);
	});

	it("keeps the direct OpenAI cost-tier defaults below the cap", () => {
		//#given - 5.6 luna/terra ship the 272k tier, 5.6 sol its 650k default, astra its 600k default,
		// GPT-6 Sol and GPT-6.1 Sol their 400k default and GPT-6 Luna the full 922k input cap, all on purpose
		const openai = getBuiltinModels("openai");
		const byId = new Map(openai.map((model) => [model.id, model.contextWindow]));

		//#then
		expect(byId.get("gpt-5.6-luna")).toBe(272_000);
		expect(byId.get("gpt-5.6-terra")).toBe(272_000);
		expect(byId.get("gpt-5.6-sol")).toBe(650_000);
		expect(byId.get("gpt-6-astra")).toBe(600_000);
		expect(byId.get("gpt-6-sol")).toBe(400_000);
		expect(byId.get("gpt-6.1-sol")).toBe(400_000);
		expect(byId.get("gpt-6-luna")).toBe(922_000);
	});
});
