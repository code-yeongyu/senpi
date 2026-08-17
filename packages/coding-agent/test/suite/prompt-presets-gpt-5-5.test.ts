import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildGpt55Prompt } from "../../src/core/extensions/builtin/prompt-preset/gpt-5.5.ts";
import { type PromptPresetSettings, resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider: string, api: Api = "openai-responses"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

describe("GPT 5.5 skill gate", () => {
	it("renders visible-skill scan gate exactly once", () => {
		const prompt = buildGpt55Prompt({
			cwd: "/tmp",
			selectedTools: ["read"],
			toolSnippets: { read: "r" },
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		});
		expect(prompt).toContain("terminal gate before substantive");
		let c = 0,
			i = prompt.indexOf("terminal gate before substantive");
		while (i !== -1) {
			c++;
			i = prompt.indexOf("terminal gate before substantive", i + 1);
		}
		expect(c).toBe(1);
	});
});

describe("GPT 5.5 prompt preset", () => {
	it("routes gpt-5.5 to its preset", () => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("gpt-5.5", "openai");
		const preset = resolvePreset(model, settings);
		expect(preset?.name).toBe("gpt-5.5");
		expect(preset?.prompt).toContain("terminal gate before substantive");
	});
});
