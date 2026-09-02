import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
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

	it("keeps plain claude-fable-5 on the claude-fable-5 preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-fable-5", "anthropic");

		// when
		const presetName = resolvePresetName(model, settings);

		// then
		expect(presetName).toBe("claude-fable-5");
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
