import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { visibleErrorLines } from "../stream-start-stall-support.ts";

/**
 * senpi#1628: a Codex WebSocket drop after partial output ended the turn with
 * `senpi:no-turn-retry:WebSocket closed 1006 Connection ended` - no retry, no
 * fallback, the raw marker in the transcript. The credential pool no longer
 * stamps the marker for a transport fault, so the session engine must treat the
 * drop like any other mid-stream provider failure; a lane that still stamps it
 * (Claude SDK) must stay unreplayed, with the marker never reaching the user.
 */
const WEBSOCKET_DROP = "WebSocket closed 1006 Connection ended";
const MARKER = "senpi:no-turn-retry:";

function droppedMidReply(errorMessage: string): AssistantMessage {
	return fauxAssistantMessage("partial reply", { stopReason: "error", errorMessage });
}

describe("WebSocket drop after partial output (senpi#1628)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("retries the turn on the same model and completes it", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([droppedMidReply(WEBSOCKET_DROP), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		const finalAssistant = harness
			.eventsOfType("message_end")
			.filter((event) => event.message.role === "assistant")
			.map((event) => event.message as AssistantMessage)
			.at(-1);
		expect(finalAssistant?.stopReason).toBe("stop");
	});

	it("explains an exhausted retry in plain language instead of the raw close text", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([droppedMidReply(WEBSOCKET_DROP), droppedMidReply(WEBSOCKET_DROP)]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		const ends = harness.eventsOfType("auto_retry_end");
		expect(ends).toMatchObject([{ success: false, attempt: 1 }]);
		const finalError = ends[0]?.finalError ?? "";
		expect(finalError).toContain("dropped before the reply finished");
		expect(finalError).toContain("/fallback");
		expect(finalError).not.toMatch(/^WebSocket closed/);
		expect(visibleErrorLines(harness).join("\n")).toContain("dropped before the reply finished");
	});

	it("still never replays a turn whose lane stamped the marker, and never shows the marker", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([droppedMidReply(`${MARKER}${WEBSOCKET_DROP}`), fauxAssistantMessage("must not run")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		const lines = visibleErrorLines(harness).join("\n");
		expect(lines).not.toContain(MARKER);
		expect(lines).toContain("dropped before the reply finished");
	});
});
