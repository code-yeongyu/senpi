import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression for #1005: a provider that answers every 429 with the same tiny
 * retry-after hint used to pin the same-model wait at that hint forever, so the
 * session hammered a rate-limited model (429 storm). Every same-model 429 wait
 * is now floored by the exponential schedule baseDelayMs * 2^(attempt-1);
 * longer provider hints still win.
 */
describe("issue #1005: repeated short 429 hints escalate on the exponential floor", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("escalates delays as 10/20/40 despite a constant 5ms retry-after hint", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 } },
		});
		harnesses.push(harness);

		const rateLimited = () =>
			fauxAssistantMessage("", {
				stopReason: "error" as const,
				errorMessage: "rate_limit_exceeded: retry-after-ms: 5",
			});

		harness.setResponses([rateLimited(), rateLimited(), rateLimited(), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([10, 20, 40]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(0);
		expect(harness.eventsOfType("retry_fallback_exhausted")).toHaveLength(0);
		expect(harness.session.isRetrying).toBe(false);
	});
});
