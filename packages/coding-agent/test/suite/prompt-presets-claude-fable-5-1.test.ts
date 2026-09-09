import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { TEST_DISCIPLINE_RULES } from "../../src/core/dynamic-prompt/verification.ts";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider: string, api: Api = "anthropic-messages"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

describe("Claude Fable 5.1 prompt preset", () => {
	it.each([
		"claude-fable-5-1",
		"anthropic/claude-fable-5.1",
		"us.anthropic.claude-fable-5-1",
		"global.anthropic.claude-fable-5-1",
		"Claude Fable 5.1",
		"claude-mythos-5-1",
		"anthropic/claude-mythos-5.1",
		"us.anthropic.claude-mythos-5-1",
		"claude-mythos-5-1-thinking",
		"Claude Mythos 5.1",
	])("resolves %s to the claude-fable-5-1 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-fable-5-1");
		expect(preset?.prompt).toContain("You are senpi");
	});

	it.each(["claude-fable-5", "claude-mythos-5", "claude-mythos-5-thinking"])(
		"keeps the plain 5 release %s on the claude-fable-5 preset",
		(modelId) => {
			// given
			const settings: PromptPresetSettings = { promptPreset: "auto" };
			const model = createModel(modelId, "anthropic");

			// when
			const presetName = resolvePresetName(model, settings);

			// then
			expect(presetName).toBe("claude-fable-5");
		},
	);

	it("keeps every shared test-discipline rule in the dieted core", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-fable-5-1", "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		for (const rule of TEST_DISCIPLINE_RULES) {
			expect(preset?.prompt).toContain(rule.directive);
		}
	});

	it("allows settings.json to force claude-fable-5-1 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "claude-fable-5-1" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-fable-5-1");
	});
});
