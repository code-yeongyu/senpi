import { describe, expect, it } from "vitest";
import { getModels, getSupportedThinkingLevels } from "../src/compat.ts";
import type { ModelThinkingLevel } from "../src/types.ts";

type CapabilityCase = {
	provider: Parameters<typeof getModels>[0];
	id: string;
	levels: ModelThinkingLevel[];
};

const ON_OFF: ModelThinkingLevel[] = ["off", "high"];
const ALWAYS_ON: ModelThinkingLevel[] = ["high"];
const QWEN38_GRADED: ModelThinkingLevel[] = ["off", "low", "medium", "xhigh"];

const DIRECT_QWEN38_CAPABILITY_CASES: CapabilityCase[] = [
	{ provider: "alibaba-token-plan", id: "qwen3.8-flash", levels: QWEN38_GRADED },
	{ provider: "alibaba-token-plan", id: "qwen3.8-max", levels: QWEN38_GRADED },
	{ provider: "alibaba-token-plan", id: "qwen3.8-max-preview", levels: QWEN38_GRADED },
	{ provider: "qwen-token-plan", id: "qwen3.8-flash", levels: QWEN38_GRADED },
	{ provider: "qwen-token-plan", id: "qwen3.8-max", levels: QWEN38_GRADED },
	{ provider: "qwen-token-plan-cn", id: "qwen3.8-flash", levels: QWEN38_GRADED },
	{ provider: "qwen-token-plan-cn", id: "qwen3.8-max", levels: QWEN38_GRADED },
	{ provider: "qwen-token-plan-individual", id: "qwen3.8-max", levels: QWEN38_GRADED },
];

// #891: Every current map-less reasoning row must have an explicit catalog capability.
// This is intentionally a complete current-row table: a removed or renamed row fails instead
// of silently disappearing from the regression.
const CAPABILITY_CASES: CapabilityCase[] = [
	{ provider: "alibaba-token-plan", id: "deepseek-v3.2", levels: ON_OFF },
	{ provider: "alibaba-token-plan", id: "kimi-k2.5", levels: ON_OFF },
	{ provider: "alibaba-token-plan", id: "kimi-k2.6", levels: ON_OFF },
	{ provider: "alibaba-token-plan", id: "kimi-k2.7-code", levels: ALWAYS_ON },
	{ provider: "alibaba-token-plan", id: "qwen3.6-flash", levels: ON_OFF },
	{ provider: "alibaba-token-plan", id: "qwen3.6-plus", levels: ON_OFF },
	{ provider: "alibaba-token-plan", id: "qwen3.7-max", levels: ON_OFF },
	{ provider: "alibaba-token-plan", id: "qwen3.7-plus", levels: ON_OFF },
	{ provider: "alibaba-token-plan", id: "qwen3.8-flash", levels: QWEN38_GRADED },
	{ provider: "alibaba-token-plan", id: "qwen3.8-max", levels: QWEN38_GRADED },
	{ provider: "alibaba-token-plan", id: "qwen3.8-max-preview", levels: QWEN38_GRADED },
	...(["qwen-token-plan", "qwen-token-plan-cn"] as const).flatMap((provider) => [
		{ provider, id: "MiniMax-M2.5", levels: ON_OFF },
		{ provider, id: "deepseek-v3.2", levels: ON_OFF },
		{ provider, id: "kimi-k2.5", levels: ON_OFF },
		{ provider, id: "kimi-k2.6", levels: ON_OFF },
		{ provider, id: "kimi-k2.7-code", levels: ON_OFF },
		{ provider, id: "qwen3.6-flash", levels: ON_OFF },
		{ provider, id: "qwen3.6-plus", levels: ON_OFF },
		{ provider, id: "qwen3.7-max", levels: ON_OFF },
		{ provider, id: "qwen3.7-plus", levels: ON_OFF },
	]),
	{ provider: "qwen-token-plan-individual", id: "qwen3.6-flash", levels: ON_OFF },
	{ provider: "qwen-token-plan-individual", id: "qwen3.7-max", levels: ON_OFF },
	{ provider: "qwen-token-plan-individual", id: "qwen3.7-plus", levels: ON_OFF },
	...(["moonshotai", "moonshotai-cn"] as const).flatMap((provider) => [{ provider, id: "kimi-k2.6", levels: ON_OFF }]),
	{ provider: "opencode", id: "kimi-k2.6", levels: ON_OFF },
	{ provider: "opencode-go", id: "qwen3.6-plus", levels: ON_OFF },
	{ provider: "xiaomi", id: "mimo-v2.5", levels: ON_OFF },
	{ provider: "xiaomi", id: "mimo-v2.5-pro", levels: ON_OFF },
	{ provider: "xiaomi", id: "mimo-v2.5-pro-ultraspeed", levels: ON_OFF },
	...(["xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp"] as const).flatMap((provider) => [
		{ provider, id: "mimo-v2.5", levels: ON_OFF },
		{ provider, id: "mimo-v2.5-pro", levels: ON_OFF },
	]),
	{ provider: "zai", id: "glm-4.7", levels: ALWAYS_ON },
	{ provider: "zai", id: "glm-5-turbo", levels: ON_OFF },
	{ provider: "zai-coding-cn", id: "glm-4.6v", levels: ON_OFF },
	{ provider: "zai-coding-cn", id: "glm-4.7", levels: ALWAYS_ON },
	{ provider: "zai-coding-cn", id: "glm-5-turbo", levels: ON_OFF },
	{ provider: "zai-coding-cn", id: "glm-5.1", levels: ON_OFF },
	{ provider: "zai-coding-cn", id: "glm-5v-turbo", levels: ON_OFF },
];

describe("issue #891 generated thinking capabilities", () => {
	it.each(
		(["moonshotai", "moonshotai-cn"] as const).flatMap((provider) =>
			[
				"kimi-k2-0711-preview",
				"kimi-k2-0905-preview",
				"kimi-k2-thinking",
				"kimi-k2-thinking-turbo",
				"kimi-k2-turbo-preview",
				"kimi-k2.5",
			].map((id) => ({ provider, id })),
		),
	)("does not restore upstream-retired $provider/$id", ({ provider, id }) => {
		expect(getModels(provider).map((model) => model.id)).not.toContain(id);
	});

	it.each(CAPABILITY_CASES)("limits $provider/$id to its serialized control surface", ({ provider, id, levels }) => {
		const model = getModels(provider).find((candidate) => candidate.id === id);

		expect(model, `missing current catalog row ${provider}/${id}`).toBeDefined();
		if (!model) throw new Error(`missing current catalog row ${provider}/${id}`);
		expect(getSupportedThinkingLevels(model)).toEqual(levels);
	});

	it.each(DIRECT_QWEN38_CAPABILITY_CASES)(
		"keeps documented Qwen3.8 reasoning effort controls graded for $provider/$id",
		({ provider, id, levels }) => {
			const model = getModels(provider).find((candidate) => candidate.id === id);

			expect(model).toBeDefined();
			if (!model) throw new Error(`missing ${provider}/${id}`);
			expect(getSupportedThinkingLevels(model)).toEqual(levels);
		},
	);
});
