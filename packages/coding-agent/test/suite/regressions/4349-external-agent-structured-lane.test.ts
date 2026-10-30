import { expect, it } from "vitest";
import { StructuredLaneUnavailableError } from "../../../src/core/structured-session-lane.ts";
import { createHarness } from "../harness.ts";
import { scriptProvider, textReply } from "../structured-lane-support.ts";

// #4349: the session must not silently reattach a channel to an externally constructed Agent.
it("reports the structured lane unavailable for an externally constructed Agent", async () => {
	const harness = await createHarness();
	try {
		expect(() => harness.session.subscribeStructured(() => {})).toThrow(StructuredLaneUnavailableError);
		scriptProvider(harness, [textReply("legacy still works")]);
		await harness.session.prompt("go");
		expect(harness.events.some((event) => event.type === "message_end")).toBe(true);
	} finally {
		harness.cleanup();
	}
});
