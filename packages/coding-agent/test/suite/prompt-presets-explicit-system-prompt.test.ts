import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("prompt preset explicit system prompt precedence", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("sends an explicit replacement instead of the selected model preset", async () => {
		// given
		const replacement = "You are the Implementer worker. Never spawn workers.";
		const extensionsResult = await createTestExtensionsResult([promptPresetExtension]);
		const resourceLoader = createTestResourceLoader({ extensionsResult, systemPrompt: replacement });
		expect(resourceLoader.getSystemPrompt()).toBe(replacement);
		const harness = await createHarness({
			models: [{ id: "grok-4.5", name: "Grok 4.5", reasoning: true }],
			resourceLoader,
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		// when
		await harness.session.prompt("ROLE: Implementer");

		// then
		const systemPrompt = harness.faux.getCallLog()[0]?.context.systemPrompt;
		expect(systemPrompt).toBe(replacement);
		expect(systemPrompt).not.toContain("CEO and orchestrator");
	});

	it("places an explicit suffix after the selected model preset", async () => {
		// given
		const suffix = "Worker-specific final contract.";
		const extensionsResult = await createTestExtensionsResult([promptPresetExtension]);
		const resourceLoader = createTestResourceLoader({ extensionsResult, appendSystemPrompt: [suffix] });
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([suffix]);
		const harness = await createHarness({
			models: [{ id: "grok-4.5", name: "Grok 4.5", reasoning: true }],
			resourceLoader,
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		// when
		await harness.session.prompt("Continue");

		// then
		const systemPrompt = harness.faux.getCallLog()[0]?.context.systemPrompt;
		expect(systemPrompt).toContain("CEO and orchestrator");
		expect(systemPrompt?.endsWith(suffix)).toBe(true);
	});

	it("sends an explicitly empty replacement without applying a preset", async () => {
		// given
		const extensionsResult = await createTestExtensionsResult([promptPresetExtension]);
		const resourceLoader = createTestResourceLoader({ extensionsResult, systemPrompt: "" });
		const harness = await createHarness({
			models: [{ id: "grok-4.5", name: "Grok 4.5", reasoning: true }],
			resourceLoader,
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		// when
		await harness.session.prompt("ROLE: Implementer");

		// then
		expect(harness.faux.getCallLog()[0]?.context.systemPrompt).toBe("");
	});
});
