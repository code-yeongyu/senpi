import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("fallback context admission", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	for (const reason of ["refusal", "rate-limit", "hard-error"] as const) {
		it(`settles ${reason} recovery without advertising or persisting a rejected model`, async () => {
			const harness = await createHarness({
				models: [
					{ id: "primary", contextWindow: 100_000, maxTokens: 64 },
					{ id: "small", contextWindow: 20_000, maxTokens: 64 },
				],
				settings: {
					compaction: { enabled: false },
					retry: {
						enabled: true,
						maxRetries: reason === "refusal" ? 1 : 0,
						fallbackChains: { "faux/primary": ["faux/small"] },
					},
				},
			});
			harnesses.push(harness);
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "long context ".repeat(8_000) }],
				timestamp: 1,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const sessionId = harness.sessionManager.getSessionId();
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: reason === "hard-error" ? "unauthorized" : "429 rate limit exceeded",
					...(reason === "refusal" ? { stopDetails: { type: "refusal" as const } } : {}),
				}),
			]);

			await harness.session.prompt("recover");

			expect(harness.session.model?.id).toBe("primary");
			expect(harness.sessionManager.getSessionId()).toBe(sessionId);
			expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary"]);
			expect(harness.eventsOfType("model_changed")).toEqual([]);
			expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(harness.session.retryAttempt).toBe(0);
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "model_change" && entry.modelId === "small"),
			).toEqual([]);
		});
	}
});
