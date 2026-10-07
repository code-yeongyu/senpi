import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";
import { neverStartsStream, RAW_STREAM_START_WATCHDOG, visibleErrorLines } from "./stream-start-stall-support.ts";

/**
 * senpi#1740, the failover half: once the same-model budget is spent on a
 * stream-start stall, a model that can still serve the turn must take it over
 * without the user typing a model command, and a turn with no remaining
 * candidate must explain itself instead of printing the watchdog's own message.
 *
 * The candidate source is the fallback chain entry for the active model - the
 * single lane `RetryFallbackController.nextCandidate` consults, which is also
 * how a host publishes the later rungs of a model profile or category.
 */
const primary = "faux/faux-1";
const fallback = "faux/faux-2";

describe("stream-start stall failover", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("hands the turn to the next candidate and makes its answer the outcome", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.agent.streamStartTimeoutMs = 20;
		harness.setResponses([neverStartsStream(), neverStartsStream(), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		// The configured same-model budget is spent first, then the from/to notice.
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, chainKey: primary, reason: "transient" },
		]);
		// The fallback answer is the turn result, and no printed line carries the
		// watchdog's interpolated message.
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(getAssistantTexts(harness).at(-1)).toBe("fallback answer");
		expect(visibleErrorLines(harness).join("\n")).not.toMatch(RAW_STREAM_START_WATCHDOG);
	});

	it("explains the stall in plain language when no candidate is left", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.agent.streamStartTimeoutMs = 20;
		harness.setResponses([neverStartsStream(), neverStartsStream()]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		const ends = harness.eventsOfType("auto_retry_end");
		expect(ends).toMatchObject([{ success: false, attempt: 1 }]);
		// Names what stalled, the model it stalled on, and what to do about it.
		const finalError = ends[0]?.finalError ?? "";
		expect(finalError).not.toMatch(RAW_STREAM_START_WATCHDOG);
		expect(finalError).toContain(primary);
		expect(finalError).toContain("never started sending a response");
		expect(finalError).toContain("/fallback");
		expect(finalError).toContain("retry.provider.streamStartTimeoutMs");
		expect(visibleErrorLines(harness).join("\n")).not.toMatch(RAW_STREAM_START_WATCHDOG);
	});
});
