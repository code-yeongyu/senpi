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

describe("Claude Fable 5.2 prompt preset", () => {
	it.each([
		"claude-fable-5-2",
		"anthropic/claude-fable-5.2",
		"anthropic.claude-fable-5-2",
		"us.anthropic.claude-fable-5-2",
		"global.anthropic.claude-fable-5-2",
		"claude-fable-5-2-fast",
		"claude-fable-5-2-20261109",
		"Claude Fable 5.2",
		"claude-mythos-5-2",
		"anthropic/claude-mythos-5.2",
		"anthropic.claude-mythos-5-2",
		"Claude Mythos 5.2",
	])("resolves %s to the claude-fable-5-2 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "anthropic");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-fable-5-2");
	});

	it.each([
		["claude-fable-5-1", "claude-fable-5-1"],
		["claude-mythos-5-1", "claude-fable-5-1"],
		["claude-fable-5", "claude-fable-5"],
		["claude-mythos-5", "claude-fable-5"],
		["claude-mythos-5-thinking", "claude-fable-5"],
		// A dated Fable 5 snapshot starts with "fable-5-2" and is still Fable 5.
		["claude-fable-5-20260601", "claude-fable-5"],
		["us.anthropic.claude-mythos-5-20260601-v1:0", "claude-fable-5"],
	])("keeps the earlier release %s on its own preset", (modelId, expected) => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		expect(resolvePresetName(createModel(modelId, "anthropic"), settings)).toBe(expected);
	});

	it("routes user questions through ask_user_question when it is available", () => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-fable-5-2", "anthropic");

		const preset = resolvePreset(model, settings);

		expect(preset?.prompt).toContain("ask_user_question");
	});

	it("allows settings.json to force claude-fable-5-2 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "claude-fable-5-2" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-fable-5-2");
	});
});
