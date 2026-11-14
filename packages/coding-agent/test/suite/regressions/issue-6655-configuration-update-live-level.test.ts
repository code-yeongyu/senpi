import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6655: on a model flagged `supportsConfigurationUpdate`, the newest `configuration_update` in the
// request is the effort it carries (replayed as an item, or folded into reasoning.effort on Sign in with
// ChatGPT). A fallback rung's level must be that update for the rung's requests, and must never reach the
// session file, where a resume inside the fallback window would pin it over the user's level.

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

function requestUpdate(seen: Array<string | undefined>): FauxResponseFactory {
	return (context) => {
		seen.push(context.messages.findLast((message) => message.role === "configurationUpdate")?.effort);
		return fauxAssistantMessage("fallback answer");
	};
}

function persistedEfforts(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "configuration_update" ? [entry.reasoning.effort] : []));
}

describe("a fallback rung's level is the configuration_update in force (senpi#6655)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("the rung's request carries its level, and the session file keeps the user's", async () => {
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
		const seen: Array<string | undefined> = [];
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			requestUpdate(seen),
		]);

		await harness.session.prompt("trigger fallback");

		expect(harness.session.model?.id).toBe("luna-b");
		expect(harness.session.thinkingLevel).toBe("low");
		expect(seen).toEqual(["low"]);
		// A resume inside the fallback window rebuilds this context: its newest update is still the user's level.
		expect(persistedEfforts(harness).at(-1)).toBe("high");
	});
});
