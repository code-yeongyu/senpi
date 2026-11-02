import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const CUSTOM_PROMPT = "Custom base prompt.";
const APPENDS = ["First CLI append.", "Second CLI append."];
const JOINED_APPENDS = APPENDS.join("\n\n");
// Established preset sentinels (same tokens the model-switch suite pins).
const GPT_55_PRESET_SENTINEL = "outcome-first";
const OPUS_47_PRESET_SENTINEL = "full set rather than the first item";

async function createPresetLoader(overrides: {
	systemPrompt?: string;
	appendSystemPrompt?: string[];
}): Promise<ResourceLoader> {
	const extensionsResult = await createTestExtensionsResult([promptPresetExtension]);
	return {
		...createTestResourceLoader({ extensionsResult }),
		getSystemPrompt: () => overrides.systemPrompt,
		getAppendSystemPrompt: () => overrides.appendSystemPrompt ?? [],
	};
}

describe("prompt preset vs user system-prompt overrides", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps the user's custom system prompt on a preset model turn", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true }],
			resourceLoader: await createPresetLoader({ systemPrompt: CUSTOM_PROMPT, appendSystemPrompt: APPENDS }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		// when
		await harness.session.prompt("hi");

		// then
		expect(harness.session.systemPrompt).toBe(`${CUSTOM_PROMPT}\n\n${JOINED_APPENDS}`);
		expect(harness.session.systemPrompt).not.toContain(GPT_55_PRESET_SENTINEL);
	});

	it("reapplies user appends after the preset replaces the base prompt", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true }],
			resourceLoader: await createPresetLoader({ appendSystemPrompt: APPENDS }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		// when
		await harness.session.prompt("hi");

		// then
		expect(harness.session.systemPrompt).toContain(GPT_55_PRESET_SENTINEL);
		expect(harness.session.systemPrompt.endsWith(`\n\n${JOINED_APPENDS}`)).toBe(true);
	});

	it("still applies the preset on a turn when no user overrides exist", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true }],
			resourceLoader: await createPresetLoader({}),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		// when
		await harness.session.prompt("hi");

		// then
		expect(harness.session.systemPrompt).toContain(GPT_55_PRESET_SENTINEL);
	});

	it("keeps the user's custom system prompt across a model switch to a preset model", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
				{ id: "claude-opus-4-7", name: "Opus 4.7", reasoning: true },
			],
			resourceLoader: await createPresetLoader({ systemPrompt: CUSTOM_PROMPT }),
		});
		harnesses.push(harness);
		const opus = harness.getModel("claude-opus-4-7");
		if (!opus) throw new Error("Missing test model: claude-opus-4-7");

		// when
		const promptChange = await harness.session.setModel(opus);

		// then
		expect(promptChange).toBeUndefined();
		expect(harness.session.systemPrompt).toBe(CUSTOM_PROMPT);
		expect(harness.session.systemPrompt).not.toContain(OPUS_47_PRESET_SENTINEL);
	});

	it("reapplies user appends after the preset prompt on model switch", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
				{ id: "claude-opus-4-7", name: "Opus 4.7", reasoning: true },
			],
			resourceLoader: await createPresetLoader({ appendSystemPrompt: APPENDS }),
		});
		harnesses.push(harness);
		const opus = harness.getModel("claude-opus-4-7");
		if (!opus) throw new Error("Missing test model: claude-opus-4-7");

		// when
		const promptChange = await harness.session.setModel(opus);

		// then
		expect(promptChange?.systemPromptName).toBe("claude-opus-4-7");
		expect(harness.session.systemPrompt).toContain(OPUS_47_PRESET_SENTINEL);
		expect(harness.session.systemPrompt.endsWith(`\n\n${JOINED_APPENDS}`)).toBe(true);
	});
});
