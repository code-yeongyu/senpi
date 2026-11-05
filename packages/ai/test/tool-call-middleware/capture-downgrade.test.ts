import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { RecoveryNativeProjection } from "../../src/tool-call-middleware/recovery-native-projection.ts";
import { wrapStreamWithInvokeRecovery } from "../../src/tool-call-middleware/recovery-stream-wrapper.ts";
import type { ProviderNativeContent, TextContent, ThinkingContent, ToolCall } from "../../src/types.ts";
import {
	type AssistantProgress,
	getAssistantCapture,
	pushAssistantProgress,
} from "../../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import {
	deltaCaptures,
	drainRecords,
	firstEvent,
	progressRecords,
	publicBytes,
	publicEvents,
	recordKinds,
	recordsOnForeignBlocks,
	subscribeCaptureForEachTest,
} from "../producer-capture-records.ts";
import { createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

subscribeCaptureForEachTest();

const tool = { name: "Bash", description: "fixture", parameters: Type.Object({ command: Type.String() }) };
const invoke = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
const prose = `before ${invoke} after`;
const nativeArguments = '{"command":"echo native"}';
const searchInProgress = { type: "providerNative", subtype: "web_search_call", raw: { status: "in_progress" } };
const completedSearch = { type: "providerNative", subtype: "web_search_call", raw: { status: "completed" } };

function bufferedProviderTurn(captureBlocks: boolean): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream({ captureBlocks });
	const output = createAssistantMessage([], "pending");
	stream.push({ type: "start", partial: output });
	const thinking: ThinkingContent = { type: "thinking", thinking: "" };
	output.content.push(thinking);
	stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
	thinking.thinking = "plan";
	stream.push({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial: output });
	thinking.thinkingSignature = "sig";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
	stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
	const text: TextContent = { type: "text", text: "" };
	output.content.push(text);
	stream.push({ type: "text_start", contentIndex: 1, partial: output });
	text.text = prose;
	stream.push({ type: "text_delta", contentIndex: 1, delta: prose, partial: output });
	text.textSignature = "t1";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 1, textSignature: "t1" });
	stream.push({ type: "text_end", contentIndex: 1, content: prose, partial: output });
	const native: ProviderNativeContent = {
		type: "providerNative",
		subtype: "web_search_call",
		raw: { status: "in_progress" },
	};
	output.content.push(native);
	pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 2, phase: "insert", block: native });
	native.raw = { status: "completed" };
	pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 2, phase: "end", block: native });
	const call: ToolCall = { type: "toolCall", id: "native", name: "Bash", arguments: {} };
	output.content.push(call);
	stream.push({ type: "toolcall_start", contentIndex: 3, partial: output });
	call.arguments = { command: "echo native" };
	stream.push({ type: "toolcall_delta", contentIndex: 3, delta: nativeArguments, partial: output });
	pushAssistantProgress(stream, {
		type: "message_tool_arguments_reset",
		contentIndex: 3,
		rawArgumentPrefix: nativeArguments,
		parsedThrough: nativeArguments.length,
	});
	stream.push({ type: "toolcall_end", contentIndex: 3, toolCall: call, partial: output });
	output.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: output });
	stream.end(output);
	return stream;
}

describe("invoke recovery capture remap #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(true), [tool]));
		expect(publicBytes(publicEvents(records))).toMatchSnapshot();
	});

	it("remaps the kept records to outer indices and drops the ones the projection does not follow", async () => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(true), [tool]));
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"thinking_delta:0",
			"message_block_metadata:0",
			"thinking_end:0",
			"text_start:1",
			"text_delta:1",
			"toolcall_start:2",
			"toolcall_delta:2",
			"toolcall_end:2",
			"text_delta:3",
			"text_end:3",
			"message_block_state:4:insert",
			"message_block_state:4:end",
			"toolcall_start:5",
			"toolcall_delta:5",
			"message_tool_arguments_reset:5",
			"toolcall_end:5",
			"done",
		]);
		expect(progressRecords(records)).toEqual([
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" },
			{ type: "message_block_state", contentIndex: 4, phase: "insert", block: searchInProgress },
			{ type: "message_block_state", contentIndex: 4, phase: "end", block: completedSearch },
			{
				type: "message_tool_arguments_reset",
				contentIndex: 5,
				rawArgumentPrefix: nativeArguments,
				parsedThrough: nativeArguments.length,
			},
		]);
		const events = publicEvents(records);
		const done = firstEvent(events, "done");
		expect(recordsOnForeignBlocks(records, done.message)).toEqual([]);
		expect(events.filter((event) => getAssistantCapture(event) === undefined).map((event) => event.type)).toEqual([]);
		expect(getAssistantCapture(done)?.message?.content.map((block) => block.type)).toEqual(
			done.message.content.map((block) => block.type),
		);
	});

	it("carries the source's emission-time seed for a lagging 1:1 copy instead of capturing the copy", async () => {
		const events = publicEvents(await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(true), [tool])));
		const thinkingStart = firstEvent(events, "thinking_start", 0);
		expect(thinkingStart.partial.content[0]).toMatchObject({ thinking: "plan" });
		expect(getAssistantCapture(thinkingStart)).toMatchObject({
			block: { type: "thinking", thinking: "" },
			coveredCodeUnits: 0,
		});
		expect(deltaCaptures(events, "thinking_delta")).toEqual([{ delta: "plan", offset: 0, parsedThrough: undefined }]);
		expect(getAssistantCapture(firstEvent(events, "thinking_end", 0))?.block).toEqual({
			type: "thinking",
			thinking: "plan",
			thinkingSignature: "sig",
		});
		const nativeStart = firstEvent(events, "toolcall_start", 5);
		expect(nativeStart.partial.content[5]).toMatchObject({ arguments: { command: "echo native" } });
		expect(getAssistantCapture(nativeStart)).toMatchObject({
			block: { type: "toolCall", id: "native", arguments: {} },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		const toolDeltas = deltaCaptures(events, "toolcall_delta");
		expect(toolDeltas[1]).toEqual({ delta: nativeArguments, offset: 0, parsedThrough: nativeArguments.length });
	});

	it("captures the blocks the projection builds itself at their outer indices", async () => {
		const events = publicEvents(await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(true), [tool])));
		expect(getAssistantCapture(firstEvent(events, "text_start", 1))?.block).toMatchObject({ type: "text", text: "" });
		expect(deltaCaptures(events, "text_delta")).toEqual([
			{ delta: "before ", offset: 0, parsedThrough: undefined },
			{ delta: " after", offset: 0, parsedThrough: undefined },
		]);
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 2))).toMatchObject({
			block: { type: "toolCall", id: "recovered-antml-0", arguments: {} },
			rawArgumentPrefix: "",
		});
		const recoveredDelta = deltaCaptures(events, "toolcall_delta")[0];
		expect(recoveredDelta).toMatchObject({ offset: 0 });
		expect(JSON.parse(recoveredDelta?.delta ?? "")).toEqual({ command: "echo recovered" });
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 2))?.block).toMatchObject({
			arguments: { command: "echo recovered" },
		});
	});

	it("never captures a lagging copy whose source carried no record", async () => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(false), [tool]));
		const captured = publicEvents(records).map((event) =>
			"contentIndex" in event
				? `${event.type}:${event.contentIndex}:${getAssistantCapture(event) !== undefined}`
				: `${event.type}:${getAssistantCapture(event) !== undefined}`,
		);
		expect(captured).toEqual([
			"start:true",
			"thinking_start:0:false",
			"thinking_delta:0:false",
			"thinking_end:0:false",
			"text_start:1:true",
			"text_delta:1:true",
			"toolcall_start:2:true",
			"toolcall_delta:2:true",
			"toolcall_end:2:true",
			"text_delta:3:true",
			"text_end:3:true",
			"toolcall_start:5:false",
			"toolcall_delta:5:false",
			"toolcall_end:5:false",
			"done:true",
		]);
		expect(progressRecords(records)).toEqual([]);
	});
});

type StrayControls = {
	beforeStart?: AssistantProgress;
	beforeProse?: AssistantProgress;
	afterProse?: AssistantProgress;
};

/** Signed thinking at 0 and invoke prose at 1, plus stray controls; the source never has a block at 2. */
function proseTurnWithStrays(strays: StrayControls): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = createAssistantMessage([], "pending");
	if (strays.beforeStart) pushAssistantProgress(stream, strays.beforeStart);
	stream.push({ type: "start", partial: output });
	const thinking: ThinkingContent = { type: "thinking", thinking: "" };
	output.content.push(thinking);
	stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
	thinking.thinking = "plan";
	stream.push({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial: output });
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
	stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
	if (strays.beforeProse) pushAssistantProgress(stream, strays.beforeProse);
	const text: TextContent = { type: "text", text: "" };
	output.content.push(text);
	stream.push({ type: "text_start", contentIndex: 1, partial: output });
	text.text = prose;
	stream.push({ type: "text_delta", contentIndex: 1, delta: prose, partial: output });
	if (strays.afterProse) pushAssistantProgress(stream, strays.afterProse);
	stream.push({ type: "text_end", contentIndex: 1, content: prose, partial: output });
	output.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: output });
	stream.end(output);
	return stream;
}

const keptThinkingSignature = { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" };

describe("invoke recovery drops controls it cannot remap #4272", () => {
	it("drops a control that arrives before start or names a source block that never exists", async () => {
		const source = proseTurnWithStrays({
			beforeStart: { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "early" },
			// Outer index 2 exists (the recovered call), but no source block 2 does: forwarding it would be a guess.
			afterProse: {
				type: "message_block_state",
				contentIndex: 2,
				phase: "insert",
				block: { type: "providerNative", subtype: "web_search_call", raw: { status: "completed" } },
			},
		});
		const records = await drainRecords(wrapStreamWithInvokeRecovery(source, [tool]));
		expect(firstEvent(publicEvents(records), "done").message.content.map((block) => block.type)).toEqual([
			"thinking",
			"text",
			"toolCall",
			"text",
		]);
		expect(progressRecords(records)).toEqual([keptThinkingSignature]);
	});

	it("drops the prose block's controls, held or late, because outer blocks 1, 2 and 3 could each own them", async () => {
		const source = proseTurnWithStrays({
			beforeProse: { type: "message_block_metadata", contentIndex: 1, textSignature: "held" },
			afterProse: { type: "message_block_metadata", contentIndex: 1, textSignature: "late" },
		});
		const records = await drainRecords(wrapStreamWithInvokeRecovery(source, [tool]));
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"thinking_delta:0",
			"message_block_metadata:0",
			"thinking_end:0",
			"text_start:1",
			"text_delta:1",
			"toolcall_start:2",
			"toolcall_delta:2",
			"toolcall_end:2",
			"text_delta:3",
			"text_end:3",
			"done",
		]);
		expect(progressRecords(records)).toEqual([keptThinkingSignature]);
	});
});

describe("recovery native projection remap #4272", () => {
	it("relays a copied block's controls to its exact outer index and drops those it cannot place", async () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const message = createAssistantMessage([], "pending");
		const projection = new RecoveryNativeProjection(stream, message);
		const control = (contentIndex: number, thinkingSignatureDelta: string): AssistantProgress =>
			Object.freeze({ type: "message_block_metadata", contentIndex, thinkingSignatureDelta });
		// Declared layout: inner 0 copies to outer 0; inner 1 is prose rebuilt into outer 1..3; inner 2 copies to
		// outer 1 + 3 = 4; inner 3 is never projected.
		projection.relayProgress(control(2, "held"));
		message.content.push({ type: "thinking", thinking: "a" });
		expect(projection.recordProjectedBlock(0, 0)).toBe(true);
		projection.relayProgress(control(0, "zero"));
		expect(projection.startText(1, 1)).toBe(true);
		message.content.push(
			{ type: "text", text: "before " },
			{ type: "toolCall", id: "recovered-antml-0", name: "Bash", arguments: {} },
			{ type: "text", text: " after" },
		);
		projection.extendText(1);
		projection.relayProgress(control(1, "prose"));
		message.content.push({ type: "thinking", thinking: "b" });
		expect(projection.recordProjectedBlock(2, 4)).toBe(true);
		projection.relayProgress(control(2, "late"));
		projection.relayProgress(control(3, "never"));
		stream.end(message);
		expect(progressRecords(await drainRecords(stream))).toEqual([
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "zero" },
			{ type: "message_block_metadata", contentIndex: 4, thinkingSignatureDelta: "held" },
			{ type: "message_block_metadata", contentIndex: 4, thinkingSignatureDelta: "late" },
		]);
	});
});
