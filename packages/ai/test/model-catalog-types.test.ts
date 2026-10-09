import { expect, expectTypeOf, it } from "vitest";
import { getBuiltinModels } from "../src/providers/all.ts";
import { GITHUB_COPILOT_MODELS } from "../src/providers/github-copilot.models.ts";
import { XAI_MODELS } from "../src/providers/xai.models.ts";
import { XIAOMI_MODELS } from "../src/providers/xiaomi.models.ts";

it("derives model API, ID, and provider literals from grouped model data", () => {
	expectTypeOf(XAI_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(XAI_MODELS["grok-4.5"].id).toEqualTypeOf<"grok-4.5">();
	expectTypeOf(XAI_MODELS["grok-4.5"].provider).toEqualTypeOf<"xai">();
	expectTypeOf(XAI_MODELS["grok-4.6"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(XAI_MODELS["grok-4.6"].id).toEqualTypeOf<"grok-4.6">();
	expectTypeOf(XAI_MODELS["grok-4.7"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(XAI_MODELS["grok-4.7"].id).toEqualTypeOf<"grok-4.7">();
	expectTypeOf(XAI_MODELS["grok-4.3"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(GITHUB_COPILOT_MODELS["grok-4.7"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(GITHUB_COPILOT_MODELS["grok-4.7"].id).toEqualTypeOf<"grok-4.7">();
	expectTypeOf(XIAOMI_MODELS["mimo-v2.5-pro"].api).toEqualTypeOf<"openai-completions">();
	expectTypeOf(XIAOMI_MODELS["mimo-v2.5-pro"].id).toEqualTypeOf<"mimo-v2.5-pro">();
	expectTypeOf(XIAOMI_MODELS["mimo-v2.6-pro"].api).toEqualTypeOf<"openai-completions">();
	expectTypeOf(XIAOMI_MODELS["mimo-v2.6-pro"].id).toEqualTypeOf<"mimo-v2.6-pro">();
});

it("routes GitHub Copilot Grok 4.5 through the Responses API", () => {
	expectTypeOf(GITHUB_COPILOT_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	expect(GITHUB_COPILOT_MODELS["grok-4.5"].api).toBe("openai-responses");
});

// Regression test for https://github.com/earendil-works/pi/issues/9209
it("routes all GitHub Copilot GPT models through the Responses API", () => {
	const gptModels = Object.values(GITHUB_COPILOT_MODELS).filter((model) => model.id.startsWith("gpt-"));
	expect(gptModels.length).toBeGreaterThan(0);
	expect(gptModels.every((model) => model.api === "openai-responses")).toBe(true);
	expectTypeOf(GITHUB_COPILOT_MODELS["gpt-6-astra"].api).toEqualTypeOf<"openai-responses">();
	// D-9: the fork stamps each GPT-6 tier's prompt budget on every provider catalog
	// (Sol 400,000, Luna 922,000; gpt-6-family-catalog), so Copilot does not ship 1,000,000.
	for (const [modelId, contextWindow] of [
		["gpt-6-sol", 400000],
		["gpt-6-luna", 922000],
	] as const) {
		const model = GITHUB_COPILOT_MODELS[modelId];
		expectTypeOf(model.api).toEqualTypeOf<"openai-responses">();
		expect(model).toMatchObject({
			api: "openai-responses",
			contextWindow,
			maxTokens: 128000,
			thinkingLevelMap: { off: "none", max: "max" },
		});
	}
});

// Grok 4.7 and MiMo V2.6 Pro must be reachable on their DIRECT provider shards
// (xai.json / xiaomi.json), not only through aggregator catalogs — and through
// the builtin registry consumers actually read. The grok-4.6 / mimo-v2.5-pro
// checks are controls proving the addition did not replace an existing entry.
it("ships grok-4.7 and mimo-v2.6-pro on their direct provider shards and the builtin registry", () => {
	expect(XAI_MODELS["grok-4.6"]?.id).toBe("grok-4.6");
	expect(XAI_MODELS["grok-4.7"]?.id).toBe("grok-4.7");
	expect(XIAOMI_MODELS["mimo-v2.5-pro"]?.id).toBe("mimo-v2.5-pro");
	expect(XIAOMI_MODELS["mimo-v2.6-pro"]?.id).toBe("mimo-v2.6-pro");

	const xaiIds = getBuiltinModels("xai").map((model) => model.id);
	expect(xaiIds).toContain("grok-4.6");
	expect(xaiIds).toContain("grok-4.7");
	const xiaomiIds = getBuiltinModels("xiaomi").map((model) => model.id);
	expect(xiaomiIds).toContain("mimo-v2.5-pro");
	expect(xiaomiIds).toContain("mimo-v2.6-pro");
});
