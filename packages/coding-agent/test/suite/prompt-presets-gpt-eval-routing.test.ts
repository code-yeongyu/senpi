import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildEvalPrompt } from "../../../senpi-codemode/src/prompt/eval-prompt.ts";
import { buildGptEvalRoutingTuning } from "../../src/core/extensions/builtin/prompt-preset/gpt-eval-routing.ts";
import { type PromptPresetSettings, resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

const GPT_PRESETS = ["gpt-5", "gpt-5.2", "gpt-5.3-codex", "gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-6-astra"] as const;
const REMOVED_CODE_MODE_TOOLS = ["`exec`", "`wait`"] as const;

describe("GPT eval tool routing", () => {
	it.each(GPT_PRESETS)("%s retains eval's live multi-language policy", (presetName) => {
		// Given: a GPT preset with the persistent eval surface registered.
		const settings: PromptPresetSettings = { promptPreset: presetName };
		const model = createModel(presetName);
		const evalGuideline = buildEvalPrompt(
			{ py: true, js: true, rb: false, jl: false },
			{ spawns: false, modelId: presetName },
		).promptGuidelines[0];
		const options = {
			selectedTools: ["eval"],
			toolSnippets: { eval: "Run one persistent code cell." },
			promptGuidelines: [evalGuideline],
			contextFiles: [],
			skills: [],
		};

		// When: the system prompt is composed for that preset.
		const preset = resolvePreset(model, settings, options);

		// Then: the eval guideline is retained and the bridge names no removed tool.
		if (!preset) {
			throw new Error(`expected ${presetName} preset to resolve`);
		}
		expect(preset.prompt).toContain(evalGuideline);
		expect(preset.prompt).toContain(buildGptEvalRoutingTuning());
		for (const removedTool of REMOVED_CODE_MODE_TOOLS) {
			expect(buildGptEvalRoutingTuning()).not.toContain(removedTool);
		}
	});
});
