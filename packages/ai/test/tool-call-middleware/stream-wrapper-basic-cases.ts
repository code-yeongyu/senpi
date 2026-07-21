import { expect, it } from "vitest";
import { getProtocol } from "../../src/tool-call-middleware/context-transformer.ts";
import { wrapStreamWithToolCallMiddleware } from "../../src/tool-call-middleware/stream-wrapper.ts";
import {
	collectEvents,
	createHermesInnerStream,
	createTextOnlyInnerStream,
	createThinkingInnerStream,
	weatherTool,
} from "./stream-wrapper-fixtures.ts";

export function registerStreamWrapperBasicCases(): void {
	it("passes text-only streams unchanged when no tool calls are parsed", async () => {
		// given
		const innerStream = createTextOnlyInnerStream();
		const protocol = getProtocol("hermes");

		// when
		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		const events = await collectEvents(outerStream);
		const result = await outerStream.result();

		// then
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.content).toEqual([{ type: "text", text: "Hello there" }]);
		expect(result.stopReason).toBe("stop");
	});

	it("emits tool call events when hermes tool call markup appears in text deltas", async () => {
		// given
		const innerStream = createHermesInnerStream();
		const protocol = getProtocol("hermes");

		// when
		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		const events = await collectEvents(outerStream);

		// then
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"text_delta",
			"text_end",
			"done",
		]);

		const toolCallEndEvent = events.find((event) => event.type === "toolcall_end");
		expect(toolCallEndEvent).toMatchObject({
			type: "toolcall_end",
			toolCall: {
				id: "hermes-tool-0",
				name: "get_weather",
				arguments: {
					city: "Seoul",
				},
			},
		});

		const textEndEvent = events.find((event) => event.type === "text_end");
		expect(textEndEvent).toMatchObject({
			type: "text_end",
			content: " after",
		});
	});

	it("returns reconstructed assistant content with tool call blocks from result", async () => {
		// given
		const innerStream = createHermesInnerStream();
		const protocol = getProtocol("hermes");

		// when
		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		await collectEvents(outerStream);
		const result = await outerStream.result();

		// then
		expect(result.content).toEqual([
			{ type: "text", text: "Before " },
			{
				type: "toolCall",
				id: "hermes-tool-0",
				name: "get_weather",
				arguments: {
					city: "Seoul",
				},
			},
			{ type: "text", text: " after" },
		]);
	});

	it("changes stopReason from stop to toolUse when tool calls were emitted", async () => {
		// given
		const innerStream = createHermesInnerStream();
		const protocol = getProtocol("hermes");

		// when
		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		await collectEvents(outerStream);
		const result = await outerStream.result();

		// then
		expect(result.stopReason).toBe("toolUse");
	});

	it("passes through thinking events unchanged while still reconstructing outer result", async () => {
		// given
		const innerStream = createThinkingInnerStream();
		const protocol = getProtocol("hermes");

		// when
		const outerStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, [weatherTool]);
		const events = await collectEvents(outerStream);
		const result = await outerStream.result();

		// then
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Need to think carefully" },
			{ type: "text", text: "Done" },
		]);
	});
}
