import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("Anthropic partial thinking replay regression", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps visible failure history out of provider replay", async () => {
		// given
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			models: [{ id: "claude-opus-4-6", reasoning: true }],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					{
						type: "thinking",
						thinking: "partial signed thinking",
						thinkingSignature: "partial-signature",
					},
				],
				{ stopReason: "error", errorMessage: "overloaded_error" },
			),
			fauxAssistantMessage("recovered"),
		]);

		// when
		await harness.session.prompt("test");

		// then
		expect(harness.faux.state.callCount).toBe(2);
		const secondCall = harness.faux.getCallLog()[1];
		expect(secondCall?.context.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "test" }], timestamp: expect.any(Number) },
		]);
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.stopReason === "error" &&
					message.content.some((block) => block.type === "thinking"),
			),
		).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error" &&
						entry.message.content.some((block) => block.type === "thinking"),
				),
		).toBe(true);
	});
});
