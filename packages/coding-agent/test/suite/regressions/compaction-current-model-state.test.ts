import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Context, FauxResponseFactory } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "../harness.ts";

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role === "user") return getMessageText(message);
	}
	return "";
}

function seedLargeContext(harness: Harness): void {
	const model = harness.getModel("faux-1");
	if (!model) throw new Error("Primary model was not registered");
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "history ".repeat(22_000) }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "result ".repeat(200) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 19_900,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: now - 500,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("Regression: compaction state during model fallback", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses the active main-thread fallback model for compaction", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 50_000, maxTokens: 2048 },
				{ id: "faux-2", contextWindow: 50_000, maxTokens: 2048 },
			],
			settings: {
				compaction: {
					enabled: true,
					reserveTokens: 5000,
					keepRecentTokens: 32,
					speculativeEnabled: false,
				},
				retry: {
					enabled: true,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
			extensionFactories: [compactionExtension],
		});
		harnesses.push(harness);
		seedLargeContext(harness);

		const response: FauxResponseFactory = async (context, _options, _state, model) => {
			const prompt = lastUserText(context);
			if (prompt === "trigger fallback") {
				if (model.id === "faux-1") {
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
				}
				return fauxAssistantMessage("fallback answer");
			}
			if (prompt === "prompt after compaction") return fauxAssistantMessage("next answer");
			return fauxAssistantMessage("compacted on active fallback");
		};
		harness.setResponses([response, response, response, response]);

		await harness.session.prompt("trigger fallback");
		const compactionModels = harness.faux
			.getCallLog()
			.filter((entry) => !["trigger fallback", "prompt after compaction"].includes(lastUserText(entry.context)))
			.map((entry) => entry.modelId);

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: "faux/faux-1", to: "faux/faux-2" },
		]);
		expect(compactionModels).toEqual(["faux-2"]);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(Reflect.get(harness.session, "compactionState")).toMatchObject({
			status: "completed",
			generation: 1,
			model: { provider: "faux", id: "faux-2" },
		});

		await harness.session.prompt("prompt after compaction");
		expect(getAssistantTexts(harness)).toContain("next answer");
		expect(harness.session.model?.id).toBe("faux-2");
	});
});
