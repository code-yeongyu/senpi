import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #4345 premature OpenAI-compatible stream retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("uses one initial attempt plus three retries for a missing finish_reason", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const errorMessage = "Stream ended without finish_reason";
		harness.setResponses(
			Array.from({ length: 4 }, () =>
				fauxAssistantMessage("partial thinking", { stopReason: "error", errorMessage }),
			),
		);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2, 3]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, true, false]);
	});
});
