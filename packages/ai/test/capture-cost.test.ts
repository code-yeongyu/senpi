import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, ToolCall } from "../src/types.ts";
import {
	type AssistantRecord,
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
	pushAssistantProgress,
} from "../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

afterEach(() => vi.restoreAllMocks());

function message(): AssistantMessage {
	return {
		role: "assistant",
		api: "fixture",
		provider: "fixture",
		model: "fixture",
		timestamp: 1,
		content: [],
		stopReason: "pending",
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function read(records: AsyncIterable<AssistantRecord>): Promise<AssistantRecord[]> {
	const out: AssistantRecord[] = [];
	for await (const record of records) out.push(record);
	return out;
}

function finish(stream: AssistantMessageEventStream, partial: AssistantMessage): void {
	partial.stopReason = "stop";
	stream.push({ type: "done", reason: "stop", message: partial });
	stream.end(partial);
}

describe("capture cost #4272", () => {
	it("builds no capture object, copy or progress record for a stream with no internal reader", async () => {
		const clone = vi.spyOn(globalThis, "structuredClone");
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const partial = message();
		stream.push({ type: "start", partial });
		const text = { type: "text" as const, text: "" };
		partial.content.push(text);
		stream.push({ type: "text_start", contentIndex: 0, partial });
		for (let index = 0; index < 200; index++) {
			text.text += "x";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
		}
		stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial });
		const native = { type: "providerNative" as const, subtype: "fixture", raw: { payload: "x".repeat(4096) } };
		partial.content.push(native);
		for (const phase of ["insert", "end"] as const)
			pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 1, phase, block: native });
		finish(stream, partial);
		// Attached only after every push: a reader that arrives late never turns capture on.
		const records = await read(assistantRecords(stream));
		expect(records.filter(isAssistantProgress)).toEqual([]);
		expect(records.filter((record) => getAssistantCapture(record) !== undefined)).toEqual([]);
		expect(clone).not.toHaveBeenCalled();
		expect(records.map((record) => record.type)).toEqual([
			"start",
			"text_start",
			...Array<string>(200).fill("text_delta"),
			"text_end",
			"done",
		]);
	});

	it("keeps a subscribed delta to offsets and copies usage only when it changes", async () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const reader = assistantRecords(stream);
		const partial = message();
		stream.push({ type: "start", partial });
		const text = { type: "text" as const, text: "" };
		partial.content.push(text);
		stream.push({ type: "text_start", contentIndex: 0, partial });
		const clone = vi.spyOn(globalThis, "structuredClone");
		for (let index = 0; index < 1000; index++) {
			if (index === 500) partial.usage.output = 7;
			text.text += "xy";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "xy", partial });
		}
		expect(clone).not.toHaveBeenCalled();
		clone.mockRestore();
		stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial });
		finish(stream, partial);
		const deltas = (await read(reader))
			.filter((record) => record.type === "text_delta")
			.map((record) => getAssistantCapture(record));
		expect(deltas.map((capture) => capture?.offset)).toEqual(Array.from({ length: 1000 }, (_, index) => index * 2));
		expect(new Set(deltas.slice(0, 500).map((capture) => capture?.usage)).size).toBe(1);
		expect(new Set(deltas.slice(500).map((capture) => capture?.usage)).size).toBe(1);
		expect([deltas[499]?.usage.output, deltas[500]?.usage.output]).toEqual([0, 7]);
		expect(deltas.filter((capture) => capture === undefined || "metadata" in capture)).toEqual([]);
	});

	it("shares one frozen copy between a native insert and its unchanged end, never a stale one", async () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const reader = assistantRecords(stream);
		const partial = message();
		stream.push({ type: "start", partial });
		const clone = vi.spyOn(globalThis, "structuredClone");
		const image = { type: "providerNative" as const, subtype: "image", raw: { result: "x".repeat(1 << 20) } };
		partial.content.push(image);
		for (const phase of ["insert", "end"] as const)
			pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 0, phase, block: image });
		expect(clone).toHaveBeenCalledTimes(1);
		clone.mockRestore();
		const search = { type: "providerNative" as const, subtype: "search", raw: { status: "in_progress" } };
		partial.content.push(search);
		pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 1, phase: "insert", block: search });
		search.raw.status = "completed";
		pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 1, phase: "end", block: search });
		finish(stream, partial);
		const states = (await read(reader)).flatMap((record) => (record.type === "message_block_state" ? [record] : []));
		expect(states[0]?.block).toBe(states[1]?.block);
		expect(states.map((record) => record.block)).toMatchObject([
			{ raw: { result: image.raw.result } },
			{ raw: { result: image.raw.result } },
			{ raw: { status: "in_progress" } },
			{ raw: { status: "completed" } },
		]);
	});
});

describe("capture failure isolation #4272", () => {
	it("drops only the failing block's records, warns once and never breaks the provider stream", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const reader = assistantRecords(stream);
		const partial = message();
		stream.push({ type: "start", partial });
		const native = { type: "providerNative" as const, subtype: "fixture", raw: { callback: () => 1 } };
		partial.content.push(native);
		expect(() => {
			for (const phase of ["insert", "end"] as const)
				pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 0, phase, block: native });
		}).not.toThrow();
		const text = { type: "text" as const, text: "" };
		partial.content.push(text);
		stream.push({ type: "text_start", contentIndex: 1, partial });
		text.text = "hi";
		stream.push({ type: "text_delta", contentIndex: 1, delta: "hi", partial });
		stream.push({ type: "text_end", contentIndex: 1, content: "hi", partial });
		const tool: ToolCall = { type: "toolCall", id: "call", name: "echo", arguments: {} };
		Reflect.set(tool.arguments, "seed", Symbol("uncloneable"));
		partial.content.push(tool);
		expect(() => {
			stream.push({ type: "toolcall_start", contentIndex: 2, partial });
			stream.push({ type: "toolcall_delta", contentIndex: 2, delta: "{}", partial });
			stream.push({ type: "toolcall_end", contentIndex: 2, toolCall: tool, partial });
		}).not.toThrow();
		finish(stream, partial);
		const records = await read(reader);
		expect(records.map((record) => record.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(await stream.result()).toBe(partial);
		expect(records.filter(isAssistantProgress)).toEqual([]);
		expect(records.map((record) => getAssistantCapture(record) !== undefined)).toEqual([
			true,
			true,
			true,
			true,
			false,
			false,
			false,
			false,
		]);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
