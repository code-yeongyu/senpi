import { expect, it } from "vitest";
import { getProtocol } from "../../src/tool-call-middleware/context-transformer.ts";
import { wrapStreamWithToolCallMiddleware } from "../../src/tool-call-middleware/stream-wrapper.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import {
	collectEvents,
	createAssistantMessage,
	createErroredMorphXmlInnerStream,
	createScriptedInnerStream,
	createScriptedProtocol,
	weatherTool,
} from "./stream-wrapper-fixtures.ts";

export function registerStreamWrapperErrorCases(): void {
	it("turns a dangling partial into a flagged tool call before recovering a transport error", async () => {
		const partial = createAssistantMessage([]);
		let finishCalls = 0;
		const protocol = createScriptedProtocol(
			() => [{ type: "toolcall_start", index: 0, id: "dangling-tool", name: "get_weather" }],
			() => {
				finishCalls += 1;
				return [];
			},
		);
		const transportError = createAssistantMessage([], "error");
		transportError.errorMessage = "transport failed";
		const innerStream = createScriptedInnerStream(
			[
				{ type: "start", partial },
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "text_delta", contentIndex: 0, delta: "partial call", partial },
			],
			{ type: "error", reason: "error", error: transportError },
		);

		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		const events = await collectEvents(outerStream);
		const result = await outerStream.result();

		expect(finishCalls).toBe(1);
		expect(events.map((event) => event.type)).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "dangling-tool",
				name: "get_weather",
				arguments: {},
				incomplete: true,
				errorMessage: "Tool call stream ended before completion",
			},
		]);
	});

	it("flushes and finalizes a dangling parser call when the iterator throws", async () => {
		const partial = createAssistantMessage([]);
		let finishCalls = 0;
		const protocol = createScriptedProtocol(
			() => [
				{ type: "toolcall_start", index: 0, id: "iterator-tool", name: "get_weather" },
				{ type: "toolcall_delta", index: 0, argumentsDelta: '{"city":"Seo' },
			],
			() => {
				finishCalls += 1;
				return [];
			},
		);
		const innerStream = new AssistantMessageEventStream();
		innerStream.push({ type: "start", partial });
		innerStream.push({ type: "text_start", contentIndex: 0, partial });
		innerStream.push({ type: "text_delta", contentIndex: 0, delta: "partial call", partial });
		innerStream.fail(new Error("iterator failed"));

		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		const events = await collectEvents(outerStream);
		const result = await outerStream.result();

		expect(finishCalls).toBe(1);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "iterator-tool",
				name: "get_weather",
				arguments: { city: "Seo" },
				incomplete: true,
				errorMessage: "Tool call stream ended before completion",
			},
		]);
		expect(result.content[0]).not.toHaveProperty("partialJson");
	});
}

export function registerStreamWrapperTransportErrorCase(): void {
	it("recovers completed tool calls when the inner stream ends with a transport error", async () => {
		// given
		const innerStream = createErroredMorphXmlInnerStream();
		const protocol = getProtocol("xml");

		// when
		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		const events = await collectEvents(outerStream);
		const result = await outerStream.result();

		// then
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBe("JSON error injected into SSE stream");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: expect.any(String),
				name: "get_weather",
				arguments: { city: "Seoul" },
			},
			{ type: "text", text: "\n\n" },
		]);
	});
}
