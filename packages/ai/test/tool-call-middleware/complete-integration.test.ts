import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "../../src/providers/faux.js";
import { complete, stream } from "../../src/stream.js";
import { getProtocol, transformContext } from "../../src/tool-call-middleware/context-transformer.js";
import { wrapStreamWithToolCallMiddleware } from "../../src/tool-call-middleware/stream-wrapper.js";
import type { Context, Tool } from "../../src/types.js";

function userMessage(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a location",
	parameters: Type.Object({
		city: Type.String(),
	}),
};

const calculatorTool: Tool = {
	name: "calculate",
	description: "Perform calculation",
	parameters: Type.Object({
		expression: Type.String(),
	}),
};

describe("complete() with tool-call-middleware", () => {
	it("returns AssistantMessage with ToolCall content when hermes format is used", async () => {
		// given
		const faux = registerFauxProvider({
			tokensPerSecond: 1000, // Fast for tests
		});

		// Simulate a model that outputs hermes-format tool calls in text
		const hermesOutput =
			'I will check the weather for you. <tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';

		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("What's the weather in Seoul?")],
			tools: [weatherTool],
		};

		// Transform context and wrap stream (simulating what stream() will do after Task 10)
		const protocol = getProtocol("hermes");
		const transformedContext = transformContext(context, protocol);

		// when - manually wrap the stream to test complete() behavior
		const innerStream = stream(model, transformedContext);
		const wrappedStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, context.tools ?? []);
		const result = await wrappedStream.result();

		// then
		expect(result.role).toBe("assistant");
		expect(result.content).toHaveLength(2);

		// First block should be text before the tool call
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "I will check the weather for you. ",
		});

		// Second block should be the parsed ToolCall
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Seoul" },
		});

		// stopReason should be changed to toolUse
		expect(result.stopReason).toBe("toolUse");

		faux.unregister();
	});

	it("returns unchanged behavior for normal text-only responses", async () => {
		// given
		const faux = registerFauxProvider({
			tokensPerSecond: 1000,
		});

		const normalText = "The weather in Seoul is sunny and 25 degrees Celsius.";
		faux.setResponses([fauxAssistantMessage([fauxText(normalText)], { stopReason: "stop" })]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("What's the weather in Seoul?")],
			tools: [weatherTool],
		};

		// when - using middleware even with normal text
		const protocol = getProtocol("hermes");
		const transformedContext = transformContext(context, protocol);
		const innerStream = stream(model, transformedContext);
		const wrappedStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, context.tools ?? []);
		const result = await wrappedStream.result();

		// then - should pass through unchanged
		expect(result.role).toBe("assistant");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: normalText,
		});
		expect(result.stopReason).toBe("stop");

		faux.unregister();
	});

	it("handles multiple tool calls in a single response", async () => {
		// given
		const faux = registerFauxProvider({
			tokensPerSecond: 1000,
		});

		// Multiple tool calls in hermes format
		const hermesOutput =
			'Let me help you. <tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>\n' +
			'<tool_call>{"name":"calculate","arguments":{"expression":"25 * 9/5 + 32"}}</tool_call>';

		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("What's the weather in Seoul and convert 25C to F?")],
			tools: [weatherTool, calculatorTool],
		};

		// when
		const protocol = getProtocol("hermes");
		const transformedContext = transformContext(context, protocol);
		const innerStream = stream(model, transformedContext);
		const wrappedStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, context.tools ?? []);
		const result = await wrappedStream.result();

		// then
		// Content: text + toolCall + text (newline) + toolCall = 4 blocks
		expect(result.content).toHaveLength(4);

		// Text before first tool call
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Let me help you. ",
		});

		// First tool call
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Seoul" },
		});

		// Text between tool calls (the newline)
		expect(result.content[2]).toMatchObject({
			type: "text",
			text: "\n",
		});

		// Second tool call
		expect(result.content[3]).toMatchObject({
			type: "toolCall",
			name: "calculate",
			arguments: { expression: "25 * 9/5 + 32" },
		});

		expect(result.stopReason).toBe("toolUse");

		faux.unregister();
	});

	it("works without tools (no transformation needed)", async () => {
		// given
		const faux = registerFauxProvider({
			tokensPerSecond: 1000,
		});

		const responseText = "Hello! How can I help you today?";
		faux.setResponses([fauxAssistantMessage([fauxText(responseText)], { stopReason: "stop" })]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("Hi there!")],
			// No tools
		};

		// when - complete without middleware wrapping
		const result = await complete(model, context);

		// then
		expect(result.role).toBe("assistant");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: responseText,
		});
		expect(result.stopReason).toBe("stop");

		faux.unregister();
	});

	it("preserves usage metadata through complete()", async () => {
		// given
		const faux = registerFauxProvider({
			tokensPerSecond: 1000,
		});

		const hermesOutput = '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("Weather in Paris?")],
			tools: [weatherTool],
		};

		// when
		const protocol = getProtocol("hermes");
		const transformedContext = transformContext(context, protocol);
		const innerStream = stream(model, transformedContext);
		const wrappedStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, context.tools ?? []);
		const result = await wrappedStream.result();

		// then - usage should be preserved
		expect(result.usage).toBeDefined();
		expect(result.usage.input).toBeGreaterThanOrEqual(0);
		expect(result.usage.output).toBeGreaterThanOrEqual(0);
		expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0);

		faux.unregister();
	});

	it("handles errors gracefully through complete()", async () => {
		// given
		const faux = registerFauxProvider({
			tokensPerSecond: 1000,
		});

		faux.setResponses([
			fauxAssistantMessage([fauxText("Error occurred")], {
				stopReason: "error",
				errorMessage: "Something went wrong",
			}),
		]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("Test error handling")],
			tools: [weatherTool],
		};

		// when
		const protocol = getProtocol("hermes");
		const transformedContext = transformContext(context, protocol);
		const innerStream = stream(model, transformedContext);
		const wrappedStream = wrapStreamWithToolCallMiddleware(innerStream, protocol, context.tools ?? []);
		const result = await wrappedStream.result();

		// then
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Something went wrong");

		faux.unregister();
	});
});

describe("complete() direct integration (simulating Task 10 stream() wrapper)", () => {
	it("demonstrates that complete() inherits middleware behavior from stream()", async () => {
		// given
		const faux = registerFauxProvider({
			tokensPerSecond: 1000,
		});

		const hermesOutput = '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("Weather in Tokyo?")],
			tools: [weatherTool],
		};

		// when - simulate what will happen when stream() has built-in middleware
		// complete() calls stream().result(), so it automatically gets wrapped behavior
		const protocol = getProtocol("hermes");
		const transformedContext = transformContext(context, protocol);

		// This is what complete() does internally: stream().result()
		const s = stream(model, transformedContext);
		const wrappedStream = wrapStreamWithToolCallMiddleware(s, protocol, context.tools ?? []);
		const result = await wrappedStream.result();

		// then - complete() would return this same result when stream() has middleware
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Tokyo" },
		});
		expect(result.stopReason).toBe("toolUse");

		faux.unregister();
	});
});
