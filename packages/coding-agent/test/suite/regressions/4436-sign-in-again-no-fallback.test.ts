import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSignInRequiredError } from "../../../src/core/extensions/builtin/anthropic-subscription/sign-in-again.ts";
import { createHarness, type Harness } from "../harness.ts";
import { visibleErrorLines } from "../stream-start-stall-support.ts";

/**
 * senpi#4436: a turn whose Claude accounts all must sign in again fails with the sign-in-again prompt. Another
 * model fails the same way until the user signs in, so the turn ends once: no same-model retry and no fallback
 * hop (the S6 QA saw one extra attempt on a sibling model, repeating the same error).
 */
describe("senpi#4436 the sign-in-again error ends the turn", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("runs no retry and no sibling model, and shows the prompt", async () => {
		// Given
		const errorMessage = new ClaudeSignInRequiredError(["work"]).message;
		const harness = await createHarness({
			provider: "anthropic-subscription",
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 2,
					baseDelayMs: 1,
					fallbackChains: { "anthropic-subscription/faux-1": ["anthropic-subscription/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			fauxAssistantMessage("must not run"),
		]);
		// When
		await harness.session.prompt("hello");
		await harness.session.waitForIdle();
		// Then
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		const lines = visibleErrorLines(harness).join("\n");
		expect(lines).toContain("Sign in again with Claude to keep using: work");
	});
});
