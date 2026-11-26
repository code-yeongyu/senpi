import { describe, expect, it } from "vitest";
import { wrapStreamWithKimiThinkingRecovery } from "../../src/tool-call-middleware/protocols/kimi-xtml/thinking-recovery-stream.ts";
import type { AssistantMessageEvent, TextContent, ThinkingContent, ToolCall } from "../../src/types.ts";
import {
	type AssistantRecord,
	getAssistantCapture,
	isAssistantProgress,
	pushAssistantProgress,
} from "../../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import {
	drainRecords,
	firstEvent,
	progressRecords,
	publicEvents,
	recordsOnForeignBlocks,
	subscribeCaptureForEachTest,
} from "../producer-capture-records.ts";
import { createAssistantMessage } from "./stream-wrapper-fixtures.ts";

subscribeCaptureForEachTest();

const leakedThinking = "plan<|open|>response answer";
const callArguments = '{"city":"Seoul"}';

/** Thinking at 0, signed text at 1, a native call at 2; `lateThinkingEnd` ends the thinking after the text starts. */
function thinkingTextCall(thinkingText: string, options: { lateThinkingEnd?: boolean } = {}) {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = createAssistantMessage([], "pending");
	const pushed: AssistantMessageEvent[] = [];
	const push = (event: AssistantMessageEvent) => {
		pushed.push(event);
		stream.push(event);
	};
	push({ type: "start", partial: output });
	const thinking: ThinkingContent = { type: "thinking", thinking: "" };
	output.content.push(thinking);
	push({ type: "thinking_start", contentIndex: 0, partial: output });
	thinking.thinking = thinkingText;
	push({ type: "thinking_delta", contentIndex: 0, delta: thinkingText, partial: output });
	const endThinking = () => push({ type: "thinking_end", contentIndex: 0, content: thinkingText, partial: output });
	if (!options.lateThinkingEnd) endThinking();
	const text: TextContent = { type: "text", text: "" };
	output.content.push(text);
	push({ type: "text_start", contentIndex: 1, partial: output });
	if (options.lateThinkingEnd) endThinking();
	text.text = "final";
	push({ type: "text_delta", contentIndex: 1, delta: "final", partial: output });
	text.textSignature = "t1";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 1, textSignature: "t1" });
	push({ type: "text_end", contentIndex: 1, content: "final", partial: output });
	const call: ToolCall = { type: "toolCall", id: "c1", name: "get_weather", arguments: {} };
	output.content.push(call);
	push({ type: "toolcall_start", contentIndex: 2, partial: output });
	call.arguments = { city: "Seoul" };
	push({ type: "toolcall_delta", contentIndex: 2, delta: callArguments, partial: output });
	pushAssistantProgress(stream, {
		type: "message_tool_arguments_reset",
		contentIndex: 2,
		rawArgumentPrefix: callArguments,
		parsedThrough: callArguments.length,
	});
	push({ type: "toolcall_end", contentIndex: 2, toolCall: call, partial: output });
	output.stopReason = "toolUse";
	push({ type: "done", reason: "toolUse", message: output });
	stream.end(output);
	return { stream, pushed };
}

function capturedIndexes(events: AssistantMessageEvent[]): string[] {
	return events.flatMap((event) =>
		"contentIndex" in event && getAssistantCapture(event) !== undefined
			? [`${event.type}:${event.contentIndex}`]
			: [],
	);
}

function carryingRecords(records: AssistantRecord[]): AssistantRecord[] {
	return records.filter((record) => isAssistantProgress(record) || getAssistantCapture(record) !== undefined);
}

// Live events keep their source indices and only the terminal is rewritten, so a block that a split moves keeps its
// public events but loses every record: lack, never wrong.
describe("Kimi thinking recovery drops the records of blocks a split moves #4272", () => {
	it("forwards no record for a text block or a tool call that the split moves", async () => {
		const source = thinkingTextCall(leakedThinking);
		const records = await drainRecords(wrapStreamWithKimiThinkingRecovery(source.stream));
		const events = publicEvents(records);
		const done = firstEvent(events, "done");
		// Thinking 0 recovers to thinking + text, so source 1 lands at 2 and source 2 at 3.
		expect(done.message.content.map((block) => block.type)).toEqual(["thinking", "text", "text", "toolCall"]);
		expect(capturedIndexes(events)).toEqual(["thinking_start:0", "thinking_delta:0", "thinking_end:0"]);
		expect(progressRecords(records)).toEqual([]);
		expect(recordsOnForeignBlocks(carryingRecords(records), done.message)).toEqual([]);
		// Public bytes are unchanged: the same event objects cross, with only their records dropped.
		events.slice(0, -1).forEach((event, index) => expect(event).toBe(source.pushed[index]));
	});

	it("keeps every record of the later blocks when the thinking before them does not split", async () => {
		const records = await drainRecords(wrapStreamWithKimiThinkingRecovery(thinkingTextCall("plan").stream));
		const events = publicEvents(records);
		expect(capturedIndexes(events)).toEqual([
			"thinking_start:0",
			"thinking_delta:0",
			"thinking_end:0",
			"text_start:1",
			"text_delta:1",
			"text_end:1",
			"toolcall_start:2",
			"toolcall_delta:2",
			"toolcall_end:2",
		]);
		expect(progressRecords(records).map((progress) => progress.contentIndex)).toEqual([1, 2]);
		expect(recordsOnForeignBlocks(records, firstEvent(events, "done").message)).toEqual([]);
	});

	it("drops a block's records for good once it started while an earlier thinking block was open", async () => {
		const records = await drainRecords(
			wrapStreamWithKimiThinkingRecovery(thinkingTextCall("plan", { lateThinkingEnd: true }).stream),
		);
		// Its start had no record, so its later deltas, end and controls carry none either.
		expect(capturedIndexes(publicEvents(records))).toEqual([
			"thinking_start:0",
			"thinking_delta:0",
			"thinking_end:0",
			"toolcall_start:2",
			"toolcall_delta:2",
			"toolcall_end:2",
		]);
		expect(progressRecords(records).map((progress) => progress.contentIndex)).toEqual([2]);
	});
});
