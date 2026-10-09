import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { neverStartsStream, RAW_STREAM_START_WATCHDOG, visibleErrorLines } from "./stream-start-stall-support.ts";

/**
 * senpi#1740: a provider that accepts the request and never emits a first stream
 * event is bounded by the agent-loop stream-start watchdog, and the watchdog's
 * own `Error.message` became the turn's visible outcome - the user read
 * `Provider stream start timed out after 180000ms` and nothing else.
 *
 * These tests drive the real watchdog instead of a scripted error string: the
 * provider stub accepts the call and settles only when the request is aborted,
 * so the watchdog firing is the only way an attempt can end. Nothing here
 * sleeps, polls, or races a competing event.
 */
describe("provider stream-start stall user surface", () => {
	const harnesses: Harness[] = [];
	const uncaught: unknown[] = [];
	const unhandled: unknown[] = [];
	const onUncaught = (error: unknown) => uncaught.push(error);
	const onUnhandled = (reason: unknown) => unhandled.push(reason);

	beforeEach(() => {
		uncaught.length = 0;
		unhandled.length = 0;
		process.on("uncaughtException", onUncaught);
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onUnhandled);
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("keeps the session alive and never shows the raw watchdog string as the turn's outcome", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.agent.streamStartTimeoutMs = 20;
		harness.setResponses([neverStartsStream(), neverStartsStream()]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		// 1. Liveness: the watchdog and the abort of the dead request stay handled,
		//    and the session is interactive again once the turn settles.
		expect(uncaught).toEqual([]);
		expect(unhandled).toEqual([]);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_idle");

		// 2. The watchdog still bounds every attempt, and the retry in flight is
		//    reported as a retry rather than as the answer to the turn.
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);

		// 3. The turn's visible outcome explains the stall instead of dumping the
		//    watchdog's interpolated message.
		const ends = harness.eventsOfType("auto_retry_end");
		expect(ends).toMatchObject([{ success: false, attempt: 1 }]);
		const finalError = ends[0]?.finalError ?? "";
		expect(finalError).not.toMatch(RAW_STREAM_START_WATCHDOG);
		expect(finalError).toContain("never started sending a response");
		expect(finalError).toContain("/fallback");
		expect(finalError).toContain("retry.provider.streamStartTimeoutMs");

		// 4. Nothing the transcript printed carries the raw watchdog string either.
		expect(visibleErrorLines(harness).join("\n")).not.toMatch(RAW_STREAM_START_WATCHDOG);
	});

	it("keeps the stall classified for the retry engine while rewriting only the user copy", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.agent.streamStartTimeoutMs = 20;
		harness.setResponses([neverStartsStream(), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		// The retry only happens because the raw wording still classifies as a
		// provider stall on the message itself; the rewrite is presentation-only.
		const stalled = harness
			.eventsOfType("message_end")
			.filter((event) => event.message.role === "assistant")
			.map((event) => event.message as AssistantMessage)
			.find((message) => message.stopReason === "error");
		expect(stalled?.errorMessage).toMatch(RAW_STREAM_START_WATCHDOG);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(visibleErrorLines(harness).join("\n")).not.toMatch(RAW_STREAM_START_WATCHDOG);
	});
});
