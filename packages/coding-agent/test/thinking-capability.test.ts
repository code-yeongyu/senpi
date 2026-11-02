import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { classifyReasoningCapability } from "../src/core/thinking-levels.ts";

function baseModel(overrides: Partial<Model<Api>> & { id: string }): Model<Api> {
	return {
		name: overrides.id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		...overrides,
	} as Model<Api>;
}

describe("classifyReasoningCapability", () => {
	it("classifies reasoning:false models as none (moonshotai/kimi-k2-0905-preview catalog shape)", () => {
		const model = baseModel({
			id: "kimi-k2-0905-preview",
			provider: "moonshotai",
			reasoning: false,
		});
		expect(classifyReasoningCapability(model)).toEqual({
			kind: "none",
			levels: ["off"],
			nonOffLevels: [],
		});
	});

	it("classifies an off-vetoing map as always-on (moonshotai/kimi-k2.7-code catalog shape)", () => {
		const model = baseModel({
			id: "kimi-k2.7-code",
			provider: "moonshotai",
			reasoning: true,
			thinkingLevelMap: { off: null },
		});
		expect(classifyReasoningCapability(model)).toEqual({
			kind: "always-on",
			levels: ["minimal", "low", "medium", "high"],
			nonOffLevels: ["minimal", "low", "medium", "high"],
		});
	});

	it("classifies a sparse map as graded (qwen-token-plan/deepseek-v4-pro catalog shape)", () => {
		const model = baseModel({
			id: "deepseek-v4-pro",
			provider: "qwen-token-plan",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
		});
		expect(classifyReasoningCapability(model)).toEqual({
			kind: "graded",
			levels: ["off", "high", "max"],
			nonOffLevels: ["high", "max"],
		});
	});

	it("classifies a map-less reasoning model without xhigh/max family markers as graded with the truncated ladder", () => {
		const model = baseModel({ id: "acme-thinker-1", reasoning: true });
		expect(classifyReasoningCapability(model)).toEqual({
			kind: "graded",
			levels: ["off", "minimal", "low", "medium", "high"],
			nonOffLevels: ["minimal", "low", "medium", "high"],
		});
	});

	it("classifies a map-less model with xhigh/max family markers as graded with the full ladder", () => {
		const model = baseModel({ id: "claude-opus-5", reasoning: true });
		expect(classifyReasoningCapability(model)).toEqual({
			kind: "graded",
			levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			nonOffLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
		});
	});

	it("classifies a model with exactly one non-off level as on-off", () => {
		const model = baseModel({
			id: "toggle-thinker",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
		});
		expect(classifyReasoningCapability(model)).toEqual({
			kind: "on-off",
			levels: ["off", "high"],
			nonOffLevels: ["high"],
		});
	});

	it("never throws on a malformed map that vetoes every level and falls back to kind none with levels ['off']", () => {
		const model = baseModel({
			id: "broken-map",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: null,
			},
		});
		let result: ReturnType<typeof classifyReasoningCapability> | undefined;
		expect(() => {
			result = classifyReasoningCapability(model);
		}).not.toThrow();
		expect(result).toEqual({ kind: "none", levels: ["off"], nonOffLevels: [] });
	});
});
