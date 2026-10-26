import { afterEach, describe, expect, it, vi } from "vitest";
import { getProtocol } from "../../src/tool-call-middleware/context-transformer.ts";
import { wrapStreamWithKimiThinkingRecovery } from "../../src/tool-call-middleware/protocols/kimi-xtml/thinking-recovery-stream.ts";
import { RecoveryAssistantMessageEventStream } from "../../src/tool-call-middleware/recovery-event-stream.ts";
import { wrapStreamWithToolCallMiddleware } from "../../src/tool-call-middleware/stream-wrapper.ts";
import type { AssistantMessageEvent, TextContent, ThinkingContent } from "../../src/types.ts";
import {
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
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
import { createAssistantMessage, weatherTool } from "./stream-wrapper-fixtures.ts";

subscribeCaptureForEachTest();
afterEach(() => vi.restoreAllMocks());

const leakedThinking = "plan<|open|>response answer";
const hermesText = 'Before <tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call> after';

function signedThinkingThenText(text: string) {
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
	thinking.thinking = "plan";
	push({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial: output });
	thinking.thinkingSignature = "sig";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
	push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
	if (text) {
		const block: TextContent = { type: "text", text: "" };
		output.content.push(block);
		push({ type: "text_start", contentIndex: 1, partial: output });
		block.text = text;
		push({ type: "text_delta", contentIndex: 1, delta: text, partial: output });
		push({ type: "text_end", contentIndex: 1, content: text, partial: output });
	}
	output.stopReason = "stop";
	push({ type: "done", reason: "stop", message: output });
	stream.end(output);
	return { stream, pushed };
}

function leakedKimiThinking() {
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
	thinking.thinking = leakedThinking;
	push({ type: "thinking_delta", contentIndex: 0, delta: leakedThinking, partial: output });
	thinking.thinkingSignature = "sig";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
	push({ type: "thinking_end", contentIndex: 0, content: leakedThinking, partial: output });
	output.stopReason = "stop";
	push({ type: "done", reason: "stop", message: output });
	stream.end(output);
	return { stream, pushed };
}

describe("Kimi thinking recovery relays capture records #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		const records = await drainRecords(wrapStreamWithKimiThinkingRecovery(leakedKimiThinking().stream));
		expect(publicBytes(publicEvents(records))).toMatchSnapshot();
	});

	it("passes every source record through and relays the rewritten terminal", async () => {
		const source = leakedKimiThinking();
		const records = await drainRecords(wrapStreamWithKimiThinkingRecovery(source.stream));
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"thinking_delta:0",
			"message_block_metadata:0",
			"thinking_end:0",
			"done",
		]);
		expect(progressRecords(records)).toEqual([
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" },
		]);
		const events = publicEvents(records);
		expect(events.slice(0, -1)).toEqual(source.pushed.slice(0, -1));
		events.slice(0, -1).forEach((event, index) => {
			expect(event).toBe(source.pushed[index]);
			expect(getAssistantCapture(event)).toBeDefined();
		});
		const done = firstEvent(events, "done");
		expect(done.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		const terminal = getAssistantCapture(done);
		expect(terminal?.message).toEqual(done.message);
		expect(terminal?.usage).toEqual(done.message.usage);
		expect(terminal?.metadata?.diagnostics).toEqual(done.message.diagnostics);
		expect(recordsOnForeignBlocks(records, done.message)).toEqual([]);
	});
});

/** Thinking at 0, then a signed text block at 1; strays add a control before `start` and one naming block 2. */
function kimiThinkingThenSignedText(thinkingText: string, options: { endThinking?: boolean; strays?: boolean } = {}) {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = createAssistantMessage([], "pending");
	if (options.strays)
		pushAssistantProgress(stream, {
			type: "message_block_metadata",
			contentIndex: 0,
			thinkingSignatureDelta: "early",
		});
	stream.push({ type: "start", partial: output });
	const thinking: ThinkingContent = { type: "thinking", thinking: "" };
	output.content.push(thinking);
	stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
	thinking.thinking = thinkingText;
	stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinkingText, partial: output });
	thinking.thinkingSignature = "sig";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
	if (options.endThinking !== false)
		stream.push({ type: "thinking_end", contentIndex: 0, content: thinkingText, partial: output });
	const text: TextContent = { type: "text", text: "" };
	output.content.push(text);
	stream.push({ type: "text_start", contentIndex: 1, partial: output });
	text.text = "final";
	stream.push({ type: "text_delta", contentIndex: 1, delta: "final", partial: output });
	text.textSignature = "t1";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 1, textSignature: "t1" });
	if (options.strays)
		pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 2, textSignature: "nowhere" });
	stream.push({ type: "text_end", contentIndex: 1, content: "final", partial: output });
	output.stopReason = "stop";
	stream.push({ type: "done", reason: "stop", message: output });
	stream.end(output);
	return stream;
}

const thinkingSignature = { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" };
const textSignature = { type: "message_block_metadata", contentIndex: 1, textSignature: "t1" };

// The live stream keeps source indices and only the terminal is rewritten, so a control crosses only while its
// source index also names its block in the terminal.
describe("Kimi thinking recovery drops controls it cannot place #4272", () => {
	it("keeps a later block's control at its source index when no earlier thinking block splits", async () => {
		const records = await drainRecords(wrapStreamWithKimiThinkingRecovery(kimiThinkingThenSignedText("plan")));
		// Thinking 0 recovers to one block, so the signed text stays at index 1 of the terminal.
		expect(firstEvent(publicEvents(records), "done").message.content.map((block) => block.type)).toEqual([
			"thinking",
			"text",
		]);
		expect(progressRecords(records)).toEqual([thinkingSignature, textSignature]);
	});

	it("drops a control that arrives before start or names a block the turn never has", async () => {
		const stream = kimiThinkingThenSignedText("plan", { strays: true });
		const records = await drainRecords(wrapStreamWithKimiThinkingRecovery(stream));
		expect(progressRecords(records)).toEqual([thinkingSignature, textSignature]);
	});

	it("drops a later block's control when the thinking before it splits: index 1 live, index 2 in the terminal", async () => {
		const records = await drainRecords(
			wrapStreamWithKimiThinkingRecovery(kimiThinkingThenSignedText(leakedThinking)),
		);
		const done = firstEvent(publicEvents(records), "done");
		expect(done.message.content).toEqual([
			{ type: "thinking", thinking: "plan", thinkingSignature: "sig" },
			{ type: "text", text: " answer" },
			{ type: "text", text: "final", textSignature: "t1" },
		]);
		expect(progressRecords(records)).toEqual([thinkingSignature]);
	});

	it("drops a later block's control while an earlier thinking block is still open", async () => {
		const stream = kimiThinkingThenSignedText("plan", { endThinking: false });
		const records = await drainRecords(wrapStreamWithKimiThinkingRecovery(stream));
		expect(progressRecords(records)).toEqual([thinkingSignature]);
	});
});

describe("legacy text tool middleware captures its own blocks #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		const wrapped = wrapStreamWithToolCallMiddleware(
			signedThinkingThenText(hermesText).stream,
			getProtocol("hermes"),
			[weatherTool],
		);
		expect(publicBytes(publicEvents(await drainRecords(wrapped)))).toMatchSnapshot();
	});

	it("captures the blocks it projects and forwards no source control for blocks it rebuilds", async () => {
		const warn = vi.spyOn(console, "warn");
		const wrapped = wrapStreamWithToolCallMiddleware(
			signedThinkingThenText(hermesText).stream,
			getProtocol("hermes"),
			[weatherTool],
		);
		const records = await drainRecords(wrapped);
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"thinking_delta:0",
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
		expect(progressRecords(records)).toEqual([]);
		const events = publicEvents(records);
		const done = firstEvent(events, "done");
		expect(recordsOnForeignBlocks(records, done.message)).toEqual([]);
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 0))?.block).toEqual({
			type: "thinking",
			thinking: "",
		});
		expect(getAssistantCapture(firstEvent(events, "thinking_end", 0))?.block).toEqual({
			type: "thinking",
			thinking: "plan",
		});
		expect(getAssistantCapture(firstEvent(events, "text_start", 1))).toBeUndefined();
		expect(deltaCaptures(events, "text_delta")).toEqual([
			{ delta: "Before ", offset: 0, parsedThrough: undefined },
			{ delta: " after", offset: 0, parsedThrough: undefined },
		]);
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 2))).toMatchObject({
			block: { type: "toolCall", name: "get_weather", arguments: {} },
			rawArgumentPrefix: "",
			coveredCodeUnits: 0,
		});
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 2))?.block).toMatchObject({
			arguments: { city: "Seoul" },
		});
		expect(getAssistantCapture(done)?.message?.content.map((block) => block.type)).toEqual([
			"thinking",
			"text",
			"toolCall",
			"text",
		]);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("recovery event stream keeps records #4272", () => {
	it("carries a forwarded record's capture onto its snapshot and keeps controls and cancellation", async () => {
		const source = signedThinkingThenText("");
		const sourceStart = source.pushed[0];
		const sourceDone = source.pushed.at(-1);
		if (sourceStart?.type !== "start" || sourceDone?.type !== "done") throw new Error("unexpected source turn");
		const outer = new RecoveryAssistantMessageEventStream();
		const cancelled = vi.fn();
		outer.setCancellationHandler(cancelled);
		const iterator = assistantRecords(outer)[Symbol.asyncIterator]();
		outer.push(sourceStart);
		pushAssistantProgress(outer, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "x" });
		outer.push(sourceDone);
		outer.end(sourceDone.message);
		const first = await iterator.next();
		const second = await iterator.next();
		if (first.done || second.done) throw new Error("records ended early");
		expect(first.value).not.toBe(sourceStart);
		expect(first.value).toEqual(sourceStart);
		expect(getAssistantCapture(first.value)).toBe(getAssistantCapture(sourceStart));
		expect(isAssistantProgress(second.value) && second.value).toEqual({
			type: "message_block_metadata",
			contentIndex: 0,
			thinkingSignatureDelta: "x",
		});
		await iterator.return?.();
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	it("relays a clean source's facts to its copy and nothing from a source captured at a drifted index", async () => {
		const source = new AssistantMessageEventStream({ captureBlocks: true });
		const sourceMessage = createAssistantMessage(
			[
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "" },
			],
			"pending",
		);
		source.push({ type: "start", partial: sourceMessage });
		const clean: AssistantMessageEvent = { type: "thinking_start", contentIndex: 0, partial: sourceMessage };
		source.push(clean);
		// Captured for block 0 while its public index names block 1: two blocks could own it.
		const drifted: AssistantMessageEvent = { type: "thinking_start", contentIndex: 1, partial: sourceMessage };
		source.push(drifted, { contentIndex: 0 });
		expect(getAssistantCapture(drifted)?.contentIndex).toBe(0);
		const outer = new RecoveryAssistantMessageEventStream();
		const outerMessage = createAssistantMessage(
			[
				{ type: "thinking", thinking: "late" },
				{ type: "thinking", thinking: "late" },
			],
			"pending",
		);
		outer.push({ type: "start", partial: outerMessage });
		outer.relaying(clean, () => outer.push({ type: "thinking_start", contentIndex: 0, partial: outerMessage }));
		outer.relaying(drifted, () => outer.push({ type: "thinking_start", contentIndex: 1, partial: outerMessage }));
		outer.end(outerMessage);
		const events = publicEvents(await drainRecords(outer));
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 0))?.block).toEqual({
			type: "thinking",
			thinking: "",
		});
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 1))).toBeUndefined();
	});

	it("carries nothing from a relaying step that pushed no copy onto a later push", async () => {
		const source = new AssistantMessageEventStream({ captureBlocks: true });
		const sourceMessage = createAssistantMessage([{ type: "thinking", thinking: "" }], "pending");
		source.push({ type: "start", partial: sourceMessage });
		const sourceStart: AssistantMessageEvent = { type: "thinking_start", contentIndex: 0, partial: sourceMessage };
		source.push(sourceStart);
		const outer = new RecoveryAssistantMessageEventStream();
		const outerMessage = createAssistantMessage([{ type: "thinking", thinking: "own" }], "pending");
		outer.push({ type: "start", partial: outerMessage });
		outer.relaying(sourceStart, () => undefined);
		outer.push({ type: "thinking_start", contentIndex: 0, partial: outerMessage });
		outer.end(outerMessage);
		const events = publicEvents(await drainRecords(outer));
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 0))?.block).toEqual({
			type: "thinking",
			thinking: "own",
		});
	});
});
