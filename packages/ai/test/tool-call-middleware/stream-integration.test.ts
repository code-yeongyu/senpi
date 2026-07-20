import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "../../src/providers/faux.ts";
import { stream, streamSimple } from "../../src/stream.ts";
import { getToolCallFormat } from "../../src/tool-call-middleware/index.ts";
import type { Context, Model, Tool } from "../../src/types.ts";

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

describe("stream() with tool-call-middleware integration", () => {
	it("activates middleware when model has toolCallFormat and tools are present", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const hermesOutput = '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [userMessage("What's the weather in Seoul?")],
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
		expect(result.role).toBe("assistant");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Seoul" },
		});
		expect(result.stopReason).toBe("toolUse");

		// Should have toolcall events in the stream
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_end");
	});

	it("passes through unchanged when model has no toolCallFormat", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const normalText = "The weather in Seoul is sunny.";
		faux.setResponses([fauxAssistantMessage([fauxText(normalText)], { stopReason: "stop" })]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("What's the weather in Seoul?")],
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
		expect(result.role).toBe("assistant");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: normalText,
		});
		expect(result.stopReason).toBe("stop");

		// Should NOT have toolcall events (middleware not activated)
		expect(events).not.toContain("toolcall_start");
		expect(events).not.toContain("toolcall_end");
	});

	it("passes through unchanged when no tools are present even with toolCallFormat", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const normalText = "Hello! How can I help you?";
		faux.setResponses([fauxAssistantMessage([fauxText(normalText)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [userMessage("Hi there!")],
			// No tools
		};

		// when
		const s = stream(model, context);
		const result = await s.result();

		// then
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: normalText,
		});
		expect(result.stopReason).toBe("stop");
	});

	it("handles multiple tool calls with hermes format", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		// Multiple tool calls in hermes format - note: consecutive tool calls may merge
		const hermesOutput =
			'<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_call>' +
			'<tool_call>{"name":"calculate","arguments":{"expression":"25 * 9/5 + 32"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [userMessage("Weather in Seoul and convert 25C to F")],
			tools: [weatherTool, calculatorTool],
		};

		// when
		const s = stream(model, context);
		const result = await s.result();

		// then - should have at least 2 tool calls
		const toolCalls = result.content.filter((c) => c.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
		});
		expect(toolCalls[1]).toMatchObject({
			type: "toolCall",
			name: "calculate",
		});
		expect(result.stopReason).toBe("toolUse");
	});

	it("handles xml format tool calls", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		// XML format uses tool name as the tag directly
		const xmlOutput = "<get_weather>\n   <city>Tokyo</city>\n</get_weather>";
		faux.setResponses([fauxAssistantMessage([fauxText(xmlOutput)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "xml");
		const context: Context = {
			messages: [userMessage("Weather in Tokyo?")],
			tools: [weatherTool],
		};

		// when
		const s = stream(model, context);
		const result = await s.result();

		// then
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "Tokyo" },
		});
		expect(result.stopReason).toBe("toolUse");
	});

	it("preserves usage metadata through stream()", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const hermesOutput = '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [userMessage("Weather in Paris?")],
			tools: [weatherTool],
		};

		// when
		const s = stream(model, context);
		const result = await s.result();

		// then
		expect(result.usage).toBeDefined();
		expect(result.usage.input).toBeGreaterThanOrEqual(0);
		expect(result.usage.output).toBeGreaterThanOrEqual(0);
		expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0);
	});

	it("handles errors gracefully through stream()", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		faux.setResponses([
			fauxAssistantMessage([fauxText("Error occurred")], {
				stopReason: "error",
				errorMessage: "Something went wrong",
			}),
		]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [userMessage("Test error")],
			tools: [weatherTool],
		};

		// when
		const s = stream(model, context);
		const result = await s.result();

		// then
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Something went wrong");
	});
});

describe("streamSimple() with tool-call-middleware integration", () => {
	it("activates middleware when model has toolCallFormat and tools are present", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const hermesOutput = '<tool_call>{"name":"get_weather","arguments":{"city":"London"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [userMessage("What's the weather in London?")],
			tools: [weatherTool],
		};

		// when
		const s = streamSimple(model, context);
		const result = await s.result();

		// then
		expect(result.role).toBe("assistant");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
			arguments: { city: "London" },
		});
		expect(result.stopReason).toBe("toolUse");
	});

	it("passes through unchanged when model has no toolCallFormat", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const normalText = "The weather in London is rainy.";
		faux.setResponses([fauxAssistantMessage([fauxText(normalText)], { stopReason: "stop" })]);

		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("What's the weather in London?")],
			tools: [weatherTool],
		};

		// when
		const s = streamSimple(model, context);
		const result = await s.result();

		// then
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: normalText,
		});
		expect(result.stopReason).toBe("stop");
	});

	it("handles multiple tool calls with streamSimple()", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const hermesOutput =
			'<tool_call>{"name":"get_weather","arguments":{"city":"Berlin"}}</tool_call>' +
			'<tool_call>{"name":"calculate","arguments":{"expression":"10 + 20"}}</tool_call>';
		faux.setResponses([fauxAssistantMessage([fauxText(hermesOutput)], { stopReason: "stop" })]);

		const model = createModelWithToolCallFormat(faux, "hermes");
		const context: Context = {
			messages: [userMessage("Weather in Berlin and calculate 10+20")],
			tools: [weatherTool, calculatorTool],
		};

		// when
		const s = streamSimple(model, context);
		const result = await s.result();

		// then - should have at least 2 tool calls
		const toolCalls = result.content.filter((c) => c.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]).toMatchObject({
			type: "toolCall",
			name: "get_weather",
		});
		expect(toolCalls[1]).toMatchObject({
			type: "toolCall",
			name: "calculate",
		});
		expect(result.stopReason).toBe("toolUse");
	});
});

describe("getToolCallFormat edge cases", () => {
	it("accepts the canonical morph-xml format and deprecated xml alias", () => {
		const faux = registerFauxProvider({ api: "openai-completions" });
		registrations.push(faux);

		expect(getToolCallFormat(createModelWithToolCallFormat(faux, "morph-xml"))).toBe("morph-xml");
		expect(getToolCallFormat(createModelWithToolCallFormat(faux, "xml"))).toBe("xml");
	});

	it("returns undefined for non-openai-completions API models", async () => {
		// given
		const faux = registerFauxProvider({
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const normalText = "Hello from anthropic API";
		faux.setResponses([fauxAssistantMessage([fauxText(normalText)], { stopReason: "stop" })]);

		// Model with anthropic-messages API (not openai-completions)
		const model = faux.getModel();
		const context: Context = {
			messages: [userMessage("Hi")],
			tools: [weatherTool],
		};

		// when - even if we try to set compat, it won't apply since API is different
		const s = stream(model, context);
		const result = await s.result();

		// then - should pass through unchanged (no middleware)
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: normalText,
		});
	});

	it("ignores invalid toolCallFormat values", async () => {
		// given
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokensPerSecond: 1000,
		});
		registrations.push(faux);

		const normalText = "Hello with invalid format";
		faux.setResponses([fauxAssistantMessage([fauxText(normalText)], { stopReason: "stop" })]);

		// Model with invalid toolCallFormat
		const model = createModelWithToolCallFormat(faux, "invalid-format");
		const context: Context = {
			messages: [userMessage("Hi")],
			tools: [weatherTool],
		};

		// when
		const s = stream(model, context);
		const result = await s.result();

		// then - should pass through unchanged (invalid format ignored)
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: normalText,
		});
	});
});
