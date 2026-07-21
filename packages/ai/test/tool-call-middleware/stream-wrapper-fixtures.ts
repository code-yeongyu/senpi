import { Type } from "typebox";
import type { StreamParserEvent, ToolCallProtocol } from "../../src/tool-call-middleware/types.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";

export const weatherTool: Tool = {
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

export function createAssistantMessage(
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

export function createTextOnlyInnerStream(): AssistantMessageEventStream {
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

export function createHermesInnerStream(): AssistantMessageEventStream {
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

export function createErroredMorphXmlInnerStream(): AssistantMessageEventStream {
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

export function createThinkingInnerStream(): AssistantMessageEventStream {
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

export async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

export function createScriptedProtocol(
	feed: (text: string) => StreamParserEvent[],
	finish: () => StreamParserEvent[],
): ToolCallProtocol {
	return {
		formatToolsSystemPrompt: () => "",
		formatToolResponse: () => "",
		formatToolCall: () => "",
		parseGeneratedText: () => [],
		createStreamParser: () => ({ feed, finish }),
	};
}

export function createScriptedInnerStream(
	events: Array<Exclude<AssistantMessageEvent, { type: "done" | "error" }>>,
	terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }>,
): AssistantMessageEventStream {
	const innerStream = new AssistantMessageEventStream();
	for (const event of events) {
		innerStream.push(event);
	}
	innerStream.push(terminal);
	return innerStream;
}
