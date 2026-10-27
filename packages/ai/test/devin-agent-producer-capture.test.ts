import { afterEach, describe, expect, it } from "vitest";
import { StopReason } from "../src/api/devin-agent/gen/cascade_pb.ts";
import { stream as streamDevin } from "../src/api/devin-agent.ts";
import { getAssistantCapture } from "../src/utils/assistant-capture.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { CONTEXT, closeStubServers, frame, MODEL, serveEdge, trailer } from "./devin-agent-stream-harness.ts";
import {
	deltaCaptures,
	drainRecords,
	firstEvent,
	mintedIdentityKeys,
	progressRecords,
	publicBytes,
	publicEvents,
	recordKinds,
	subscribeCaptureForEachTest,
} from "./producer-capture-records.ts";

subscribeCaptureForEachTest();

afterEach(closeStubServers);

async function capture() {
	const { baseUrl } = await serveEdge({
		chat: (_req, res) => {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			for (const chunk of [
				frame({ messageId: "m1", deltaThinking: "plan", deltaSignature: "s1" }),
				frame({ messageId: "m1", deltaThinking: " more", deltaSignature: "s1" }),
				frame({ messageId: "m1", deltaThinking: " end", deltaSignature: "s2" }),
				frame({ messageId: "m1", deltaToolCalls: [{ id: "call-1", name: "", argumentsJson: '{"pa' }] }),
				frame({ messageId: "m1", deltaToolCalls: [{ id: "", name: "read", argumentsJson: '{"path":"a.ts"}' }] }),
				frame({ messageId: "m1", stopReason: StopReason.FUNCTION_CALL }),
				trailer(),
			])
				res.write(chunk);
			res.end();
		},
	});
	return drainRecords(streamDevin({ ...MODEL, baseUrl }, normalizeContext(CONTEXT), { apiKey: "session-abc" }));
}

describe("Devin producer capture #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		expect(publicBytes(publicEvents(await capture()))).toMatchSnapshot();
	});

	it("records signature replacement and a late tool name in order", async () => {
		const records = await capture();
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"message_block_metadata:0",
			"thinking_delta:0",
			"thinking_delta:0",
			"message_block_metadata:0",
			"thinking_delta:0",
			"thinking_end:0",
			"toolcall_start:1",
			"toolcall_delta:1",
			"message_block_metadata:1",
			"toolcall_delta:1",
			"toolcall_end:1",
			"done",
		]);
		expect(progressRecords(records)).toEqual([
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignature: "s1" },
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignature: "s2" },
			{ type: "message_block_metadata", contentIndex: 1, name: "read" },
		]);
		const events = publicEvents(records);
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 0))?.block).toEqual({
			type: "thinking",
			thinking: "",
		});
		expect(getAssistantCapture(firstEvent(events, "thinking_end", 0))?.block).toEqual({
			type: "thinking",
			thinking: "plan more end",
			thinkingSignature: "s2",
		});
	});

	it("captures the closure-held argument text as suffix deltas with the store's parse frontier", async () => {
		const events = publicEvents(await capture());
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 1))).toMatchObject({
			block: { type: "toolCall", id: "call-1", name: "", arguments: {} },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		expect(deltaCaptures(events, "toolcall_delta")).toEqual([
			{ delta: '{"pa', offset: 0, parsedThrough: 4 },
			{ delta: 'th":"a.ts"}', offset: 4, parsedThrough: 15 },
		]);
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 1))?.block).toMatchObject({
			name: "read",
			arguments: { path: "a.ts" },
		});
		const done = getAssistantCapture(firstEvent(events, "done"))?.message;
		expect(done).toMatchObject({ stopReason: "toolUse", responseId: "m1" });
		expect(mintedIdentityKeys(done)).toEqual([]);
	});
});
