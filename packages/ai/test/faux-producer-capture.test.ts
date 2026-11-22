import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "../src/providers/faux.ts";
import { getAssistantCapture } from "../src/utils/assistant-capture.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	deltaCaptures,
	drainRecords,
	firstEvent,
	mintedIdentityKeys,
	publicBytes,
	publicEvents,
	recordKinds,
	subscribeCaptureForEachTest,
} from "./producer-capture-records.ts";

subscribeCaptureForEachTest();

function capture() {
	const core = createFauxCore({ api: "faux-capture", tokenSize: { min: 1, max: 1 } });
	core.setResponses([
		fauxAssistantMessage(
			[fauxThinking("ponder"), fauxText("hello"), fauxToolCall("echo", { text: "a b" }, { id: "call_1" })],
			{ stopReason: "toolUse", timestamp: 1 },
		),
	]);
	const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
	return drainRecords(core.stream(core.getModel(), context));
}

describe("Faux producer capture #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		expect(publicBytes(publicEvents(await capture()))).toMatchSnapshot();
	});

	it("keeps the parsed seed until the end installs arguments", async () => {
		const records = await capture();
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"thinking_delta:0",
			"thinking_delta:0",
			"thinking_end:0",
			"text_start:1",
			"text_delta:1",
			"text_delta:1",
			"text_end:1",
			"toolcall_start:2",
			"toolcall_delta:2",
			"toolcall_delta:2",
			"toolcall_delta:2",
			"toolcall_delta:2",
			"toolcall_end:2",
			"done",
		]);
		const events = publicEvents(records);
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 2))).toMatchObject({
			block: { type: "toolCall", id: "call_1", name: "echo", arguments: {} },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		// Faux never parses its generated chunks, so the frontier stays at the seed on every delta.
		expect(deltaCaptures(events, "toolcall_delta")).toEqual([
			{ delta: '{"te', offset: 0, parsedThrough: 0 },
			{ delta: 'xt":', offset: 4, parsedThrough: 0 },
			{ delta: '"a b', offset: 8, parsedThrough: 0 },
			{ delta: '"}', offset: 12, parsedThrough: 0 },
		]);
		expect(deltaCaptures(events, "thinking_delta")).toEqual([
			{ delta: "pond", offset: 0, parsedThrough: undefined },
			{ delta: "er", offset: 4, parsedThrough: undefined },
		]);
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 0))?.block).toEqual({
			type: "thinking",
			thinking: "",
		});
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 2))?.block).toMatchObject({
			arguments: { text: "a b" },
		});
		const done = getAssistantCapture(firstEvent(events, "done"))?.message;
		expect(done).toMatchObject({ stopReason: "toolUse" });
		expect(mintedIdentityKeys(done)).toEqual([]);
	});
});
