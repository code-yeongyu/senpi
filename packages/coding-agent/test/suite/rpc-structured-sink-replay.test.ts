import { expect, it, vi } from "vitest";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../../src/modes/rpc/custom-capability.ts";
import * as jsonNormal from "../../src/modes/rpc/json-normal-value.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const sink = (lines: string[]) => ({
	writeRaw: (line: string) => lines.push(line),
	waitForBackpressure: async () => {},
});
const wire = (record: object) => `${JSON.stringify({ ...record, sessionId: "session" })}\n`;

// Part of #4272: a placeholder peer attaching mid-stream must not parse the retained partials.
it("replays retained message_update partials to a late placeholder peer without parsing them", async () => {
	const writer = new SessionEventWriter(() => {});
	const replay: string[] = [];
	writer.registerConnection("live", sink([]));
	writer.attachConnectionToSession("live", "session");
	const message = { role: "assistant", content: [{ type: "text", text: "" }] };
	const expected: string[] = [];
	const accept = (record: Record<string, unknown>) => {
		writer.enqueue("session", record);
		expected.push(wire(record));
	};
	accept({ type: "message_start", message });
	for (let index = 0; index < 256; index++) {
		message.content[0].text += "x";
		accept({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "x" } });
	}
	const parse = vi.spyOn(JSON, "parse");
	try {
		writer.registerConnection("late", sink(replay));
		writer.setConnectionCapabilities("late", [MEDIA_PLACEHOLDERS_CAPABILITY]);
		writer.attachConnectionToSession("late", "session");
		await writer.flushConnection("late");
		const partialParses = parse.mock.calls.filter(([text]) => String(text).includes('"type":"message_update"'));
		expect(partialParses.length, "message_update parses during placeholder replay").toBe(0);
		expect(replay).toEqual(expected);
	} finally {
		parse.mockRestore();
		writer.unregisterConnection("live");
		writer.unregisterConnection("late");
	}
});

// Part of #4272: acceptance normalizes once; placeholder projection must not walk the record again.
it("normalizes each accepted record once when a placeholder peer is attached", async () => {
	const writer = new SessionEventWriter(() => {});
	const lines: string[] = [];
	writer.registerConnection("peer", sink(lines));
	writer.setConnectionCapabilities("peer", [MEDIA_PLACEHOLDERS_CAPABILITY]);
	writer.attachConnectionToSession("peer", "session");
	const records = [
		{
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "x" }] },
			assistantMessageEvent: { type: "text_delta", delta: "x" },
		},
		{ type: "tool_execution_end", toolCallId: "call", result: { content: [{ type: "text", text: "done" }] } },
	];
	const normalize = vi.spyOn(jsonNormal, "normalizeJsonValue");
	const parse = vi.spyOn(JSON, "parse");
	try {
		for (const record of records) writer.enqueue("session", record);
		await writer.flushConnection("peer");
		expect(normalize, "JSON-normal walks per accepted record").toHaveBeenCalledTimes(records.length);
		expect(parse).not.toHaveBeenCalled();
		expect(lines).toEqual(records.map(wire));
	} finally {
		normalize.mockRestore();
		parse.mockRestore();
		writer.unregisterConnection("peer");
	}
});
