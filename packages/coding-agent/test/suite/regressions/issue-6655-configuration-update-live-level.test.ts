import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6655: on a model flagged `supportsConfigurationUpdate`, the newest `configuration_update` in the
// transcript is the effort the request carries (replayed as an item, or folded into reasoning.effort on
// Sign in with ChatGPT). A level that reached the session without an update entry, such as a fallback
// rung's `:low`, must not leave an older update in force.

function flagCatalog(harness: Harness): void {
	harness.modelRegistry.registerProvider("openai", {
		baseUrl: harness.getModel().baseUrl,
		apiKey: "faux-key",
		api: "openai-responses",
		models: harness.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: "openai-responses",
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
			compat: { supportsConfigurationUpdate: true },
		})),
	});
}

function newestUpdateEffort(harness: Harness): string | undefined {
	return harness.agent.state.messages.findLast((message) => message.role === "configurationUpdate")?.effort;
}

describe("the newest configuration_update follows the live level (senpi#6655)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("a fallback rung's level is what the flagged fallback model's request carries", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			fallbackNow: () => 0,
			models: [
				{ id: "luna-a", reasoning: true },
				{ id: "luna-b", reasoning: true },
			],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					maxRetries: 0,
					fallbackChains: { "openai/luna-a": ["openai/luna-b:low"] },
				},
			},
		});
		harnesses.push(harness);
		flagCatalog(harness);
		const primary = harness.modelRegistry.find("openai", "luna-a");
		if (!primary) throw new Error("Missing flagged primary");
		await harness.session.setModel(primary);
		harness.session.setThinkingLevel("medium");
		harness.session.setThinkingLevel("high");
		expect(newestUpdateEffort(harness)).toBe("high");
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("trigger fallback");

		expect(harness.session.model?.id).toBe("luna-b");
		expect(harness.session.thinkingLevel).toBe("low");
		expect(newestUpdateEffort(harness)).toBe("low");
	});
});
