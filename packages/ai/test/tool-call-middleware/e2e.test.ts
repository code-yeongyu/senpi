import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	registerFauxProvider,
} from "../../src/providers/faux.js";
import { complete, stream } from "../../src/stream.js";
import type { Context, Model, Tool } from "../../src/types.js";

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

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function createModelWithToolCallFormat(
	faux: ReturnType<typeof registerFauxProvider>,
	format: string,
): Model<"openai-completions"> {
	const baseModel = faux.getModel();
	return {
		...baseModel,
		compat: {
			toolCallFormat: format,
		},
	} as Model<"openai-completions">;
}

function extractText(content: { type: string; text?: string }[]): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

// ============================================================================
// Hermes E2E
// ============================================================================

describe("Hermes E2E round-trip", () => {
	it("parses tool call from text, then formats tool result for next turn", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const hermesToolCall = '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesToolCall)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "What's the weather in Seoul?", timestamp: Date.now() }],
			tools: [weatherTool],
		};

		// when - first call: model returns text with tool call
		const firstResult = await complete(model, context);

		// then - middleware parsed the tool call
		expect(firstResult.stopReason).toBe("toolUse");
		expect(firstResult.content).toHaveLength(1);
		expect(firstResult.content[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Seoul" },
		});

		// given - add assistant response and tool result to context
		const toolCall = firstResult.content[0];
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall");
		}

		context.messages.push(firstResult);
		context.messages.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "Sunny, 25C" }],
			isError: false,
			timestamp: Date.now(),
		});

		// Capture the transformed context in the second call
		let capturedContext: Context | null = null;
		const secondResponseFactory: FauxResponseFactory = (ctx) => {
			capturedContext = ctx;
			return fauxAssistantMessage([fauxText("The weather in Seoul is sunny and 25 degrees Celsius.")]);
		};
		faux.setResponses([secondResponseFactory]);

		// when - second call: provide tool result, get text response
		const secondResult = await complete(model, context);

		// then - response is plain text
		expect(secondResult.stopReason).toBe("stop");
		expect(extractText(secondResult.content)).toContain("sunny and 25 degrees");

		// then - verify the context was transformed with hermes format
		expect(capturedContext).not.toBeNull();
		const messages = capturedContext!.messages;

		// Tool result should be transformed to user message with <tool_response> format
		const toolResultMsg = messages[messages.length - 1];
		expect(toolResultMsg?.role).toBe("user");
		if (toolResultMsg?.role === "user") {
			const content = typeof toolResultMsg.content === "string" ? toolResultMsg.content : "";
			expect(content).toContain("<tool_response>");
			expect(content).toContain("get_weather");
			expect(content).toContain("Sunny, 25C");
		}

		// Tools should be stripped from transformed context
		expect(capturedContext!.tools).toBeUndefined();

		// System prompt should contain tool definitions
		expect(capturedContext!.systemPrompt).toContain("<tools>");
	});

	it("emits toolcall events when streaming", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const hermesToolCall = '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesToolCall)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "Weather in Tokyo?", timestamp: Date.now() }],
			tools: [weatherTool],
		};

		// when
		const events: string[] = [];
		const s = stream(model, context);
		for await (const event of s) {
			events.push(event.type);
		}
		const result = await s.result();

		// then
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Tokyo" },
		});
	});
});

// ============================================================================
// MorphXml E2E
// ============================================================================

describe("MorphXml E2E round-trip", () => {
	it("parses xml tool call from text, then formats tool result for next turn", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const xmlToolCall = "<get_weather>\n   <city>Seoul</city>\n</get_weather>";
		faux.setResponses([fauxAssistantMessage([fauxText(xmlToolCall)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "xml");
		const context: Context = {
			messages: [{ role: "user", content: "What's the weather in Seoul?", timestamp: Date.now() }],
			tools: [weatherTool],
		};

		// when - first call
		const firstResult = await complete(model, context);

		// then
		expect(firstResult.stopReason).toBe("toolUse");
		expect(firstResult.content).toHaveLength(1);
		expect(firstResult.content[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Seoul" },
		});

		// given - build second turn
		const toolCall = firstResult.content[0];
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall");
		}

		context.messages.push(firstResult);
		context.messages.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "Sunny, 25C" }],
			isError: false,
			timestamp: Date.now(),
		});

		let capturedContext: Context | null = null;
		const secondResponseFactory: FauxResponseFactory = (ctx) => {
			capturedContext = ctx;
			return fauxAssistantMessage([fauxText("Seoul is sunny at 25C.")]);
		};
		faux.setResponses([secondResponseFactory]);

		// when - second call
		const secondResult = await complete(model, context);

		// then
		expect(secondResult.stopReason).toBe("stop");
		expect(extractText(secondResult.content)).toContain("Seoul is sunny");

		// Verify xml-formatted tool result in transformed context
		expect(capturedContext).not.toBeNull();
		const messages = capturedContext!.messages;
		const toolResultMsg = messages[messages.length - 1];
		expect(toolResultMsg?.role).toBe("user");
		if (toolResultMsg?.role === "user") {
			const content = typeof toolResultMsg.content === "string" ? toolResultMsg.content : "";
			expect(content).toContain("<tool_response>");
			expect(content).toContain("get_weather");
			expect(content).toContain("Sunny, 25C");
		}

		expect(capturedContext!.tools).toBeUndefined();
		expect(capturedContext!.systemPrompt).toContain("<tools>");
	});
});

// ============================================================================
// Gemma4 E2E
// ============================================================================

describe("Gemma4 E2E round-trip", () => {
	it("parses gemma4-delimiter tool call from text, then formats tool result for next turn", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const gemma4ToolCall = '<|tool_call>call:get_weather{city:<|"|>Seoul<|"|>}<tool_call|>';
		faux.setResponses([fauxAssistantMessage([fauxText(gemma4ToolCall)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "gemma4-delimiter");
		const context: Context = {
			messages: [{ role: "user", content: "What's the weather in Seoul?", timestamp: Date.now() }],
			tools: [weatherTool],
		};

		// when - first call
		const firstResult = await complete(model, context);

		// then
		expect(firstResult.stopReason).toBe("toolUse");
		expect(firstResult.content).toHaveLength(1);
		expect(firstResult.content[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Seoul" },
		});

		// given - build second turn
		const toolCall = firstResult.content[0];
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall");
		}

		context.messages.push(firstResult);
		context.messages.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "Sunny, 25C" }],
			isError: false,
			timestamp: Date.now(),
		});

		let capturedContext: Context | null = null;
		const secondResponseFactory: FauxResponseFactory = (ctx) => {
			capturedContext = ctx;
			return fauxAssistantMessage([fauxText("Seoul has sunny weather at 25C.")]);
		};
		faux.setResponses([secondResponseFactory]);

		// when - second call
		const secondResult = await complete(model, context);

		// then
		expect(secondResult.stopReason).toBe("stop");
		expect(extractText(secondResult.content)).toContain("Seoul has sunny weather");

		// Verify gemma4-formatted tool result in transformed context
		expect(capturedContext).not.toBeNull();
		const messages = capturedContext!.messages;
		const toolResultMsg = messages[messages.length - 1];
		expect(toolResultMsg?.role).toBe("user");
		if (toolResultMsg?.role === "user") {
			const content = typeof toolResultMsg.content === "string" ? toolResultMsg.content : "";
			expect(content).toContain("<|tool_response>");
			expect(content).toContain("Sunny, 25C");
		}

		// Assistant message should have tool call converted to gemma4 text format
		const assistantMsg = messages[messages.length - 2];
		expect(assistantMsg?.role).toBe("assistant");
		if (assistantMsg?.role === "assistant") {
			const textBlocks = assistantMsg.content.filter((b) => b.type === "text");
			const combinedText = textBlocks.map((b) => (b.type === "text" ? b.text : "")).join("");
			expect(combinedText).toContain("<|tool_call>");
			expect(combinedText).toContain("get_weather");
		}

		expect(capturedContext!.tools).toBeUndefined();
	});
});

// ============================================================================
// Multi-turn tool use
// ============================================================================

describe("Multi-turn tool use", () => {
	it("user -> assistant (tool call) -> tool result -> assistant (text response)", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		// First response: tool call
		const hermesToolCall = '<tool_call>{"name":"calculate","arguments":{"expression":"15 + 27"}}</tool_call>';
		// Second response: final text after tool result
		faux.setResponses([
			fauxAssistantMessage([fauxText(hermesToolCall)], { stopReason: "stop" }),
			fauxAssistantMessage([fauxText("The result of 15 + 27 is 42.")]),
		]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "What is 15 + 27?", timestamp: Date.now() }],
			tools: [calculatorTool],
		};

		// when - turn 1: model calls tool
		const turn1 = await complete(model, context);

		// then
		expect(turn1.stopReason).toBe("toolUse");
		const toolCall = turn1.content.find((b) => b.type === "toolCall");
		expect(toolCall).toBeDefined();
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall");
		}
		expect(toolCall.name).toBe("calculate");
		expect(toolCall.arguments).toEqual({ expression: "15 + 27" });

		// given - add tool result
		context.messages.push(turn1);
		context.messages.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "42" }],
			isError: false,
			timestamp: Date.now(),
		});

		// when - turn 2: model responds with text
		const turn2 = await complete(model, context);

		// then
		expect(turn2.stopReason).toBe("stop");
		expect(extractText(turn2.content)).toContain("42");
	});

	it("handles multiple sequential tool calls across turns with hermes format", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		faux.setResponses([
			// Turn 1: first tool call
			fauxAssistantMessage(
				[fauxText('<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>')],
				{ stopReason: "stop" },
			),
			// Turn 2: second tool call after first result
			fauxAssistantMessage(
				[fauxText('<tool_call>{"name":"calculate","arguments":{"expression":"25 * 9/5 + 32"}}</tool_call>')],
				{ stopReason: "stop" },
			),
			// Turn 3: final text response
			fauxAssistantMessage([fauxText("Seoul is 25C (77F).")]),
		]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "Weather in Seoul in Fahrenheit?", timestamp: Date.now() }],
			tools: [weatherTool, calculatorTool],
		};

		// when - turn 1
		const turn1 = await complete(model, context);
		expect(turn1.stopReason).toBe("toolUse");
		const tc1 = turn1.content.find((b) => b.type === "toolCall");
		if (tc1?.type !== "toolCall") {
			throw new Error("Expected toolCall");
		}

		context.messages.push(turn1);
		context.messages.push({
			role: "toolResult",
			toolCallId: tc1.id,
			toolName: tc1.name,
			content: [{ type: "text", text: "Sunny, 25C" }],
			isError: false,
			timestamp: Date.now(),
		});

		// when - turn 2
		const turn2 = await complete(model, context);
		expect(turn2.stopReason).toBe("toolUse");
		const tc2 = turn2.content.find((b) => b.type === "toolCall");
		if (tc2?.type !== "toolCall") {
			throw new Error("Expected toolCall");
		}

		context.messages.push(turn2);
		context.messages.push({
			role: "toolResult",
			toolCallId: tc2.id,
			toolName: tc2.name,
			content: [{ type: "text", text: "77" }],
			isError: false,
			timestamp: Date.now(),
		});

		// when - turn 3
		const turn3 = await complete(model, context);

		// then
		expect(turn3.stopReason).toBe("stop");
		expect(extractText(turn3.content)).toContain("Seoul");
	});
});

// ============================================================================
// Edge cases
// ============================================================================

describe("E2E edge cases", () => {
	it("passes through when model returns no tool calls (just text)", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const plainText = "I don't need any tools for this. The answer is 42.";
		faux.setResponses([fauxAssistantMessage([fauxText(plainText)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "What is 42?", timestamp: Date.now() }],
			tools: [weatherTool],
		};

		// when
		const result = await complete(model, context);

		// then
		expect(result.stopReason).toBe("stop");
		expect(extractText(result.content)).toBe(plainText);
		expect(result.content.every((b) => b.type === "text")).toBe(true);
	});

	it("handles multiple tool calls in one response", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const multiToolCall =
			'<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>' +
			'<tool_call>{"name":"calculate","arguments":{"expression":"25 * 2"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(multiToolCall)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "Weather and calculate", timestamp: Date.now() }],
			tools: [weatherTool, calculatorTool],
		};

		// when
		const result = await complete(model, context);

		// then
		expect(result.stopReason).toBe("toolUse");
		const toolCalls = result.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]).toMatchObject({ type: "toolCall", name: "get_weather" });
		expect(toolCalls[1]).toMatchObject({ type: "toolCall", name: "calculate" });
	});

	it("handles text + tool call + more text", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const mixedContent =
			'Let me check. <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call> Done checking.';
		faux.setResponses([fauxAssistantMessage([fauxText(mixedContent)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "Weather in Paris?", timestamp: Date.now() }],
			tools: [weatherTool],
		};

		// when
		const result = await complete(model, context);

		// then
		expect(result.stopReason).toBe("toolUse");

		// Should have text before, tool call, and text after
		const textBlocks = result.content.filter((b) => b.type === "text");
		const toolCalls = result.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(textBlocks.length).toBeGreaterThanOrEqual(1);
		expect(toolCalls[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Paris" },
		});

		// Verify text content surrounds the tool call
		const allText = extractText(result.content);
		expect(allText).toContain("Let me check.");
		expect(allText).toContain("Done checking.");
	});

	it("does not activate middleware when tools array is empty with toolCallFormat set", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const normalText = "Hello! No tools available.";
		faux.setResponses([fauxAssistantMessage([fauxText(normalText)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools: [], // Empty tools
		};

		// when
		const result = await complete(model, context);

		// then - middleware should NOT activate, text passes through unchanged
		expect(result.stopReason).toBe("stop");
		expect(extractText(result.content)).toBe(normalText);
	});

	it("handles very long streaming response with tool call at the end", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const longPreamble = "A".repeat(500);
		const trailingToolCall = `${longPreamble} <tool_call>{"name":"get_weather","arguments":{"city":"London"}}</tool_call>`;
		faux.setResponses([fauxAssistantMessage([fauxText(trailingToolCall)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [{ role: "user", content: "Long response then weather?", timestamp: Date.now() }],
			tools: [weatherTool],
		};

		// when
		const events: string[] = [];
		const s = stream(model, context);
		for await (const event of s) {
			events.push(event.type);
		}
		const result = await s.result();

		// then
		expect(result.stopReason).toBe("toolUse");
		const toolCalls = result.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "London" },
		});

		// Should have text content before the tool call
		const textContent = extractText(result.content);
		expect(textContent).toContain(longPreamble);

		// Stream should have both text and toolcall events
		expect(events).toContain("text_delta");
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_end");
	});

	it("xml format: handles multiple tool calls in one response", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const xmlMulti =
			"<get_weather>\n   <city>Seoul</city>\n</get_weather>\n" +
			"<calculate>\n   <expression>25 * 2</expression>\n</calculate>";
		faux.setResponses([fauxAssistantMessage([fauxText(xmlMulti)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "xml");
		const context: Context = {
			messages: [{ role: "user", content: "Weather and calc", timestamp: Date.now() }],
			tools: [weatherTool, calculatorTool],
		};

		// when
		const result = await complete(model, context);

		// then
		expect(result.stopReason).toBe("toolUse");
		const toolCalls = result.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]).toMatchObject({ type: "toolCall", name: "get_weather" });
		expect(toolCalls[1]).toMatchObject({ type: "toolCall", name: "calculate" });
	});

	it("gemma4 format: handles text + tool call", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const gemma4Mixed = 'Let me check the weather. <|tool_call>call:get_weather{city:<|"|>Berlin<|"|>}<tool_call|>';
		faux.setResponses([fauxAssistantMessage([fauxText(gemma4Mixed)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "gemma4-delimiter");
		const context: Context = {
			messages: [{ role: "user", content: "Weather in Berlin?", timestamp: Date.now() }],
			tools: [weatherTool],
		};

		// when
		const result = await complete(model, context);

		// then
		expect(result.stopReason).toBe("toolUse");
		const toolCalls = result.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Berlin" },
		});

		// Text before tool call should be preserved
		const textContent = extractText(result.content);
		expect(textContent).toContain("Let me check the weather.");
	});
});
