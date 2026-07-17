import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getProtocol, transformContext } from "../../src/tool-call-middleware/context-transformer.ts";
import type { ToolCallProtocol } from "../../src/tool-call-middleware/types.ts";
import type { AssistantMessage, Context, TextContent, Tool, ToolResultMessage } from "../../src/types.ts";

const now = () => Date.now();

function userMessage(content: string) {
	return { role: "user" as const, content, timestamp: now() };
}

function assistantMessage(content: AssistantMessage["content"], timestamp = now()): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

describe("getProtocol", () => {
	it("should return hermes protocol for 'hermes' format", () => {
		const protocol = getProtocol("hermes");
		expect(protocol).toBeDefined();
		expect(typeof protocol.formatToolsSystemPrompt).toBe("function");
		expect(typeof protocol.formatToolResponse).toBe("function");
		expect(typeof protocol.formatToolCall).toBe("function");
	});

	it("should return the same morphXml protocol for 'morph-xml' and 'xml' formats", () => {
		const canonicalProtocol = getProtocol("morph-xml");
		const aliasProtocol = getProtocol("xml");
		expect(canonicalProtocol).toBe(aliasProtocol);
		expect(typeof canonicalProtocol.formatToolsSystemPrompt).toBe("function");
	});

	it("should return gemma4 protocol for 'gemma4-delimiter' format", () => {
		const protocol = getProtocol("gemma4-delimiter");
		expect(protocol).toBeDefined();
		expect(typeof protocol.formatToolsSystemPrompt).toBe("function");
	});

	it("should return yamlXml protocol for 'yaml-xml' format", () => {
		const protocol = getProtocol("yaml-xml");
		expect(protocol).toBeDefined();
		expect(typeof protocol.formatToolsSystemPrompt).toBe("function");
	});

	it("should throw error for unsupported format", () => {
		expect(() => getProtocol("unsupported" as any)).toThrow("Unsupported tool call format");
	});
});

describe("transformContext", () => {
	const weatherTool: Tool = {
		name: "get_weather",
		description: "Get weather for a location",
		parameters: Type.Object({
			city: Type.String({ description: "City name" }),
		}),
	};

	const mockProtocol: ToolCallProtocol = {
		formatToolsSystemPrompt: (tools) =>
			tools.length > 0 ? `<tools>${tools.map((t) => t.name).join(", ")}</tools>` : "",
		formatToolResponse: (toolName, _toolCallId, content) =>
			`<tool_response>${toolName}:${content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("")}</tool_response>`,
		formatToolCall: (name, args) => `<tool_call>${name}:${JSON.stringify(args)}</tool_call>`,
		parseGeneratedText: () => [],
		createStreamParser: () => ({
			feed: () => [],
			finish: () => [],
		}),
	};

	it("should strip tools from context", () => {
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello")],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, mockProtocol);

		expect(transformed.tools).toBeUndefined();
	});

	it("should inject tool definitions into system prompt", () => {
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello")],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, mockProtocol);

		expect(transformed.systemPrompt).toContain("<tools>");
		expect(transformed.systemPrompt).toContain("get_weather");
		expect(transformed.systemPrompt).toContain("You are helpful");
	});

	it("should not modify system prompt when no tools", () => {
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello")],
			tools: [],
		};

		const transformed = transformContext(context, mockProtocol);

		expect(transformed.systemPrompt).toBe("You are helpful");
	});

	it("should not mutate original context", () => {
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello")],
			tools: [weatherTool],
		};

		const originalSystemPrompt = context.systemPrompt;
		const originalMessages = context.messages;
		const originalTools = context.tools;

		const transformed = transformContext(context, mockProtocol);

		// Original context should be unchanged
		expect(context.systemPrompt).toBe(originalSystemPrompt);
		expect(context.messages).toBe(originalMessages);
		expect(context.tools).toBe(originalTools);

		// Transformed context should be different
		expect(transformed).not.toBe(context);
		expect(transformed.systemPrompt).not.toBe(context.systemPrompt);
	});

	it("should convert AssistantMessage tool calls to text", () => {
		const assistantTurn = assistantMessage([
			{ type: "text", text: "Let me check the weather" },
			{
				type: "toolCall",
				id: "call_123",
				name: "get_weather",
				arguments: { city: "Seoul" },
			},
		]);

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [assistantTurn],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, mockProtocol);

		const transformedAssistant = transformed.messages[0] as AssistantMessage;
		expect(transformedAssistant.content).toHaveLength(2);
		expect(transformedAssistant.content[0]).toEqual({ type: "text", text: "Let me check the weather" });
		expect(transformedAssistant.content[1]).toEqual({
			type: "text",
			text: '<tool_call>get_weather:{"city":"Seoul"}</tool_call>',
		});
	});

	it("should pass through AssistantMessage without tool calls unchanged", () => {
		const assistantTurn = assistantMessage([{ type: "text", text: "Hello there" }]);

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [assistantTurn],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, mockProtocol);

		expect(transformed.messages[0]).toEqual(assistantTurn);
	});

	it("should convert ToolResultMessage to UserMessage", () => {
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_123",
			toolName: "get_weather",
			content: [{ type: "text", text: "Sunny, 23C" }],
			isError: false,
			timestamp: Date.now(),
		};

		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [toolResultMessage],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, mockProtocol);

		const transformedUser = transformed.messages[0];
		expect(transformedUser.role).toBe("user");
		expect(transformedUser.content).toBe("<tool_response>get_weather:Sunny, 23C</tool_response>");
	});

	it("should pass through user messages unchanged", () => {
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello"), userMessage("How are you?")],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, mockProtocol);

		expect(transformed.messages[0]).toEqual(context.messages[0]);
		expect(transformed.messages[1]).toEqual(context.messages[1]);
	});

	it("should handle complex conversation history", () => {
		const messages: Context["messages"] = [
			userMessage("What's the weather?"),
			assistantMessage(
				[
					{ type: "text", text: "I'll check" },
					{
						type: "toolCall",
						id: "call_1",
						name: "get_weather",
						arguments: { city: "Tokyo" },
					},
				],
				1,
			),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "get_weather",
				content: [{ type: "text", text: "Rainy" }],
				isError: false,
				timestamp: 2,
			},
			assistantMessage([{ type: "text", text: "It's rainy in Tokyo" }], 3),
		];

		const context: Context = {
			systemPrompt: "You are helpful",
			messages,
			tools: [weatherTool],
		};

		const transformed = transformContext(context, mockProtocol);

		// User message unchanged
		expect(transformed.messages[0]).toEqual(messages[0]);

		// Assistant with tool call converted
		const transformedAssistant1 = transformed.messages[1] as AssistantMessage;
		expect(transformedAssistant1.content).toHaveLength(2);
		expect(transformedAssistant1.content[1]).toEqual({
			type: "text",
			text: '<tool_call>get_weather:{"city":"Tokyo"}</tool_call>',
		});

		// Tool result converted to user message
		const transformedToolResult = transformed.messages[2];
		expect(transformedToolResult.role).toBe("user");

		// Final assistant unchanged
		expect(transformed.messages[3]).toEqual(messages[3]);
	});
});

describe("transformContext with real protocols", () => {
	const weatherTool: Tool = {
		name: "get_weather",
		description: "Get weather for a location",
		parameters: Type.Object({
			city: Type.String({ description: "City name" }),
		}),
	};

	it("replays flagged anthropic-xml calls canonically without leaking the truncated fragment", () => {
		const rawFragment = '<invoke name="get_weather"><parameter name="city">Seo';
		const retryDiagnostic =
			'Tool call "get_weather" was not executed: the response ended before the tool call was complete. Re-issue the tool call with complete arguments.';
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [
				assistantMessage([
					{
						type: "toolCall",
						id: "call_flagged",
						name: "get_weather",
						arguments: { city: "Seo" },
						incomplete: true,
						errorMessage: "Tool call was truncated mid-arguments",
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_flagged",
					toolName: "get_weather",
					content: [{ type: "text", text: retryDiagnostic }],
					isError: true,
					timestamp: 2,
				},
			],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, getProtocol("anthropic-xml"));
		const transformedAssistant = transformed.messages[0] as AssistantMessage;
		const transformedResult = transformed.messages[1];
		const replayedText = transformedAssistant.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(replayedText).toBe('<invoke name="get_weather">\n<parameter name="city">Seo</parameter>\n</invoke>');
		expect(transformedResult).toMatchObject({ role: "user" });
		expect((transformedResult as { content: string }).content).toContain(retryDiagnostic);
		expect(JSON.stringify(transformed)).not.toContain(rawFragment);
	});

	it("replays flagged hermes calls canonically without leaking the truncated fragment", () => {
		const rawFragment = '<tool_call>{"name":"get_weather","arguments":{"city":"Seo';
		const retryDiagnostic = "Re-issue the tool call with complete arguments.";
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [
				assistantMessage([
					{
						type: "toolCall",
						id: "call_flagged",
						name: "get_weather",
						arguments: { city: "Seo" },
						incomplete: true,
						errorMessage: "Tool call was truncated mid-arguments",
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_flagged",
					toolName: "get_weather",
					content: [{ type: "text", text: retryDiagnostic }],
					isError: true,
					timestamp: 2,
				},
			],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, getProtocol("hermes"));
		const transformedAssistant = transformed.messages[0] as AssistantMessage;
		const transformedResult = transformed.messages[1];
		const replayedText = transformedAssistant.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		expect(replayedText).toBe('<tool_call>\n{"name":"get_weather","arguments":{"city":"Seo"}}\n</tool_call>');
		expect(transformedResult).toMatchObject({ role: "user" });
		expect((transformedResult as { content: string }).content).toContain(retryDiagnostic);
		expect(JSON.stringify(transformed)).not.toContain(rawFragment);
	});

	it("replays flagged calls byte-identically to unflagged calls", () => {
		const baseContext: Context = {
			systemPrompt: "You are helpful",
			messages: [
				assistantMessage([
					{
						type: "toolCall",
						id: "call_123",
						name: "get_weather",
						arguments: { city: "Seo" },
					},
				]),
			],
			tools: [weatherTool],
		};
		const flaggedContext: Context = {
			...baseContext,
			messages: [
				assistantMessage(
					[
						{
							type: "toolCall",
							id: "call_123",
							name: "get_weather",
							arguments: { city: "Seo" },
							incomplete: true,
							errorMessage: "Tool call was truncated mid-arguments",
						},
					],
					baseContext.messages[0].timestamp,
				),
			],
		};

		expect(JSON.stringify(transformContext(flaggedContext, getProtocol("anthropic-xml")))).toBe(
			JSON.stringify(transformContext(baseContext, getProtocol("anthropic-xml"))),
		);
	});

	it("should use hermes protocol correctly", () => {
		const protocol = getProtocol("hermes");
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello")],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, protocol);

		expect(transformed.systemPrompt).toContain("<tools>");
		expect(transformed.systemPrompt).toContain("get_weather");
		expect(transformed.systemPrompt).toContain("<tool_call>");
	});

	it("should use morphXml protocol correctly", () => {
		const protocol = getProtocol("xml");
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello")],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, protocol);

		expect(transformed.systemPrompt).toContain("<tools>");
		expect(transformed.systemPrompt).toContain("get_weather");
		expect(transformed.systemPrompt).toContain("wrap each element in an <item> tag");
		expect(transformed.systemPrompt).toContain("Array<object> example");
	});

	it("should use gemma4 protocol correctly", () => {
		const protocol = getProtocol("gemma4-delimiter");
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello")],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, protocol);

		expect(transformed.systemPrompt).toContain("<|tool_call>");
		expect(transformed.systemPrompt).toContain("get_weather");
	});

	it("should use yamlXml protocol correctly", () => {
		const protocol = getProtocol("yaml-xml");
		const context: Context = {
			systemPrompt: "You are helpful",
			messages: [userMessage("Hello")],
			tools: [weatherTool],
		};

		const transformed = transformContext(context, protocol);

		expect(transformed.systemPrompt).toContain("<tools>");
		expect(transformed.systemPrompt).toContain("get_weather");
		expect(transformed.systemPrompt).toContain("Inside the XML element, specify parameters using YAML syntax");
	});
});
