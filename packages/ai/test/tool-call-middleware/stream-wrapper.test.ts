import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getProtocol } from "../../src/tool-call-middleware/context-transformer.js";
import { wrapStreamWithToolCallMiddleware } from "../../src/tool-call-middleware/stream-wrapper.js";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../../src/types.js";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.js";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a location",
	parameters: Type.Object({
		city: Type.String(),
	}),
};

function createUsage(): AssistantMessage["usage"] {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		content,
		usage: createUsage(),
		stopReason,
		timestamp: 123,
	};
}

function createTextOnlyInnerStream(): AssistantMessageEventStream {
	const innerStream = new AssistantMessageEventStream();
	const partial = createAssistantMessage([]);
	const message = createAssistantMessage([{ type: "text", text: "Hello there" }]);

	innerStream.push({ type: "start", partial });
	innerStream.push({ type: "text_start", contentIndex: 0, partial });
	partial.content.push({ type: "text", text: "Hello there" });
	innerStream.push({ type: "text_delta", contentIndex: 0, delta: "Hello there", partial });
	innerStream.push({ type: "text_end", contentIndex: 0, content: "Hello there", partial });
	innerStream.push({ type: "done", reason: "stop", message });

	return innerStream;
}

function createHermesInnerStream(): AssistantMessageEventStream {
	const innerStream = new AssistantMessageEventStream();
	const partial = createAssistantMessage([]);
	const hermesText = 'Before <tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call> after';
	const message = createAssistantMessage([{ type: "text", text: hermesText }]);

	innerStream.push({ type: "start", partial });
	innerStream.push({ type: "text_start", contentIndex: 0, partial });
	partial.content.push({ type: "text", text: hermesText });
	innerStream.push({ type: "text_delta", contentIndex: 0, delta: hermesText, partial });
	innerStream.push({ type: "text_end", contentIndex: 0, content: hermesText, partial });
	innerStream.push({ type: "done", reason: "stop", message });

	return innerStream;
}

function createErroredMorphXmlInnerStream(): AssistantMessageEventStream {
	const innerStream = new AssistantMessageEventStream();
	const partial = createAssistantMessage([]);
	const xmlText = "<get_weather><city>Seoul</city></get_weather>\n\n";
	const errorMessage = createAssistantMessage([{ type: "text", text: xmlText }], "error");
	errorMessage.errorMessage = "JSON error injected into SSE stream";

	innerStream.push({ type: "start", partial });
	innerStream.push({ type: "text_start", contentIndex: 0, partial });
	partial.content.push({ type: "text", text: xmlText });
	innerStream.push({ type: "text_delta", contentIndex: 0, delta: xmlText, partial });
	innerStream.push({ type: "error", reason: "error", error: errorMessage });

	return innerStream;
}

function createThinkingInnerStream(): AssistantMessageEventStream {
	const innerStream = new AssistantMessageEventStream();
	const partial = createAssistantMessage([]);
	const message = createAssistantMessage([
		{ type: "thinking", thinking: "Need to think carefully" },
		{ type: "text", text: "Done" },
	]);

	innerStream.push({ type: "start", partial });
	partial.content.push({ type: "thinking", thinking: "" });
	innerStream.push({ type: "thinking_start", contentIndex: 0, partial });
	partial.content[0] = { type: "thinking", thinking: "Need to think carefully" };
	innerStream.push({ type: "thinking_delta", contentIndex: 0, delta: "Need to think carefully", partial });
	innerStream.push({ type: "thinking_end", contentIndex: 0, content: "Need to think carefully", partial });
	innerStream.push({ type: "text_start", contentIndex: 1, partial });
	partial.content.push({ type: "text", text: "Done" });
	innerStream.push({ type: "text_delta", contentIndex: 1, delta: "Done", partial });
	innerStream.push({ type: "text_end", contentIndex: 1, content: "Done", partial });
	innerStream.push({ type: "done", reason: "stop", message });

	return innerStream;
}

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("wrapStreamWithToolCallMiddleware", () => {
	it("passes through text-only streams unchanged when no tool calls are parsed", async () => {
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
});
