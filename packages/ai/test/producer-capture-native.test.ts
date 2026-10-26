import type Anthropic from "@anthropic-ai/sdk";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage } from "../src/types.ts";
import {
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
	subscribeAssistantCapture,
	type AssistantRecord,
} from "../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

let releaseCapture = () => {};
beforeEach(() => {
	releaseCapture = subscribeAssistantCapture();
});
afterEach(() => releaseCapture());

function message(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		timestamp: 1,
		content: [],
		stopReason: "pending",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("native producer progress #4272", () => {
	it("observes Anthropic native insert/end and signature-only changes while the wire is held open", async () => {
		const wire = new TransformStream<Uint8Array, Uint8Array>();
		const writer = wire.writable.getWriter();
		const send = (frame: Record<string, unknown>) =>
			writer.write(new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
		const response = new Response(wire.readable, { headers: { "content-type": "text/event-stream" } });
		const client = {
			beta: { messages: { create: () => ({ asResponse: async () => response }) } },
		} as unknown as Anthropic;
		const stream = anthropicStream(
			getModel("anthropic", "claude-haiku-4-5"),
			normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] }),
			{ client },
		);
		const nativeEnd = Promise.withResolvers<void>();
		const records: AssistantRecord[] = [];
		const consume = (async () => {
			for await (const record of assistantRecords(stream)) {
				records.push(record);
				if (record.type === "message_block_state" && record.phase === "end") nativeEnd.resolve();
			}
		})();
		try {
			await send({
				type: "message_start",
				message: { id: "msg_fixture", usage: { input_tokens: 1, output_tokens: 0 } },
			});
			await send({
				type: "content_block_start",
				index: 0,
				content_block: { type: "redacted_thinking", data: "opaque" },
			});
			await send({ type: "content_block_stop", index: 0 });
			await send({
				type: "content_block_start",
				index: 1,
				content_block: { type: "thinking", thinking: "", signature: "" },
			});
			await send({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "signed" } });
			await send({ type: "content_block_stop", index: 1 });
			await send({
				type: "content_block_start",
				index: 2,
				content_block: { type: "server_tool_use", id: "native", name: "search", input: {} },
			});
			await send({
				type: "content_block_delta",
				index: 2,
				delta: { type: "input_json_delta", partial_json: '{ "q": "x" }' },
			});
			await send({ type: "content_block_stop", index: 2 });
			await nativeEnd.promise;
			const controls = records.filter(isAssistantProgress);
			expect(controls).toMatchObject([
				{ type: "message_block_metadata", contentIndex: 1, thinkingSignatureDelta: "signed" },
				{ type: "message_block_state", phase: "insert", contentIndex: 2, block: { raw: { input: {} } } },
				{ type: "message_block_state", phase: "end", contentIndex: 2, block: { raw: { input: { q: "x" } } } },
			]);
			const thinkingStart = records.find((record) => record.type === "thinking_start");
			if (!thinkingStart) throw new Error("no thinking_start record");
			expect(getAssistantCapture(thinkingStart)?.block).toEqual({
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: "opaque",
				redacted: true,
			});
			expect(records.some((record) => record.type === "done")).toBe(false);
		} finally {
			await send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
			await send({ type: "message_stop" });
			await writer.close();
			await consume;
		}
	});

	it("keeps Responses native replacement and terminal image backfill in original index order", async () => {
		const stream = new AssistantMessageEventStream();
		const output = message();
		const frames = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "web_search_call", id: "search", status: "in_progress" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "web_search_call", id: "search", status: "completed" },
			},
			{
				type: "response.completed",
				response: {
					id: "resp",
					status: "completed",
					output: [
						{ type: "web_search_call", id: "search", status: "completed" },
						{ type: "image_generation_call", id: "image", status: "completed", result: "YWJj" },
					],
				},
			},
		] as ResponseStreamEvent[];
		await processResponsesStream(
			(async function* () {
				yield* frames;
			})(),
			output,
			stream,
			getModel("openai", "gpt-5"),
		);
		stream.end(output);
		const records = [];
		for await (const record of assistantRecords(stream)) records.push(record);
		expect(records).toMatchObject([
			{ type: "message_block_state", contentIndex: 0, phase: "insert", block: { raw: { status: "in_progress" } } },
			{ type: "message_block_state", contentIndex: 0, phase: "end", block: { raw: { status: "completed" } } },
			{ type: "message_block_state", contentIndex: 1, phase: "insert", block: { raw: { result: "YWJj" } } },
			{ type: "message_block_state", contentIndex: 1, phase: "end", block: { raw: { result: "YWJj" } } },
		]);
	});

	it("does no parsing or content reads on no-growth deltas and retains a stale parse frontier", async () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const partial = message();
		partial.content.push({ type: "toolCall", id: "call", name: "echo", arguments: { seed: { value: 1 } } });
		const start = { type: "toolcall_start" as const, contentIndex: 0, partial };
		stream.push(start);
		const parse = vi.spyOn(JSON, "parse");
		Object.defineProperty(partial, "content", {
			get: () => {
				throw new Error("delta read content");
			},
		});
		try {
			for (let index = 0; index < 100; index++)
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "", partial });
			stream.push(
				{ type: "toolcall_delta", contentIndex: 0, delta: '{"changed":true}', partial },
				{ parsedThrough: 0 },
			);
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
		stream.end(partial);
		const records = [];
		for await (const record of assistantRecords(stream)) records.push(record);
		expect(records.slice(1).map((record) => getAssistantCapture(record)?.parsedThrough)).toEqual(Array(101).fill(0));
		expect(getAssistantCapture(start)?.block).toMatchObject({ arguments: { seed: { value: 1 } } });
		expect(Object.isFrozen(getAssistantCapture(start)?.block)).toBe(true);
	});
});
