import { afterEach, describe, expect, it } from "vitest";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function getRequiredModel(harness: Harness, modelId: string) {
	const model = harness.getModel(modelId);
	if (!model) {
		throw new Error(`Missing test model: ${modelId}`);
	}
	return model;
}

describe("prompt preset model switching", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("updates the active system prompt and emits an extension event when model switch changes preset", async () => {
		// given
		const extensionEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
				{ id: "claude-opus-4-7", name: "Opus 4.7", reasoning: true },
			],
			extensionFactories: [
				promptPresetExtension,
				(pi) => {
					pi.on("model_select", () => ({}));
					pi.on("system_prompt_change", (event) => {
						extensionEvents.push(
							`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.systemPromptName}`,
						);
					});
				},
			],
		});
		harnesses.push(harness);

		// when
		const promptChange = await harness.session.setModel(getRequiredModel(harness, "claude-opus-4-7"));

		// then
		expect(promptChange?.systemPromptName).toBe("claude-opus-4-7");
		expect(harness.session.systemPrompt).toContain("full set rather than the first item");
		expect(extensionEvents).toEqual(["gpt-5.5->claude-opus-4-7:claude-opus-4-7"]);
		expect(harness.eventsOfType("system_prompt_change").map((event) => event.systemPromptName)).toEqual([
			"claude-opus-4-7",
		]);
	});

	it("resets to the base prompt when switching from a preset model to fallback", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
				{ id: "claude-opus-4-7", name: "Opus 4.7", reasoning: true },
				{ id: "claude-sonnet-4-5", name: "Sonnet 4.5", reasoning: true },
			],
			extensionFactories: [promptPresetExtension],
		});
		harnesses.push(harness);
		await harness.session.setModel(getRequiredModel(harness, "claude-opus-4-7"));
		harness.events.length = 0;

		// when
		const promptChange = await harness.session.setModel(getRequiredModel(harness, "claude-sonnet-4-5"));

		// then
		expect(promptChange?.systemPromptName).toBe("fallback (senpi-current)");
		expect(harness.session.systemPrompt).toContain("## Available Tools");
		expect(harness.session.systemPrompt).not.toContain("full set rather than the first item");
		expect(harness.eventsOfType("system_prompt_change").map((event) => event.systemPromptName)).toEqual([
			"fallback (senpi-current)",
		]);
	});

	it("emits system_prompt_change when switching between Opus version presets", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
				{ id: "claude-opus-4-7", name: "Opus 4.7", reasoning: true },
				{ id: "claude-opus-4-6", name: "Opus 4.6", reasoning: true },
			],
			extensionFactories: [promptPresetExtension],
		});
		harnesses.push(harness);
		await harness.session.setModel(getRequiredModel(harness, "claude-opus-4-7"));
		harness.events.length = 0;

		// when
		const promptChange = await harness.session.setModel(getRequiredModel(harness, "claude-opus-4-6"));

		// then
		expect(promptChange?.systemPromptName).toBe("claude-opus-4-6");
		expect(harness.session.systemPrompt).toContain("Choose an approach and commit to it");
		expect(harness.eventsOfType("system_prompt_change").map((event) => event.systemPromptName)).toEqual([
			"claude-opus-4-6",
		]);
	});
});
