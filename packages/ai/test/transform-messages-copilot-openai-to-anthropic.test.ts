import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolCall } from "../src/types.ts";

// Normalize function matching what anthropic.ts uses
function anthropicNormalizeToolCallId(
	id: string,
	_model: Model<"anthropic-messages">,
	_source: AssistantMessage,
): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("OpenAI to Anthropic session migration for Copilot Claude", () => {
	it("converts thinking blocks to plain text when source model differs", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Let me think about this...",
						thinkingSignature: "reasoning_content",
					},
					{ type: "text", text: "Hi there!" },
				],
				api: "openai-completions",
				provider: "github-copilot",
				model: "gpt-4o",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;

		// Thinking block should be converted to text since models differ
		const textBlocks = assistantMsg.content.filter((b) => b.type === "text");
		const thinkingBlocks = assistantMsg.content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks).toHaveLength(0);
		expect(textBlocks.length).toBeGreaterThanOrEqual(2);
	});

	it("removes thoughtSignature from tool calls when migrating between models", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_123",
						name: "bash",
						arguments: { command: "ls" },
						thoughtSignature: JSON.stringify({ type: "reasoning.encrypted", id: "call_123", data: "encrypted" }),
					},
				],
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_123",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;
		const toolCall = assistantMsg.content.find((b) => b.type === "toolCall") as ToolCall;

		expect(toolCall.thoughtSignature).toBeUndefined();
	});

	it("preserves same-model redacted thinking and does not share transformed assistant content objects", () => {
		const model = makeCopilotClaudeModel();
		const redactedBlock = {
			type: "thinking" as const,
			thinking: "[Reasoning redacted]",
			thinkingSignature: "opaque-redacted-payload",
			redacted: true,
		};
		const textBlock = { type: "text" as const, text: "I need a tool." };
		const toolCallBlock = {
			type: "toolCall" as const,
			id: "call_123",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: "same-model-thought",
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [redactedBlock, textBlock, toolCallBlock],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const messages: Message[] = [{ role: "user", content: "read", timestamp: Date.now() }, assistant];
		const before = structuredClone(messages);

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const transformedAssistant = result.find((message) => message.role === "assistant") as AssistantMessage;

		expect(messages).toEqual(before);
		expect(transformedAssistant).not.toBe(assistant);
		expect(transformedAssistant.content).not.toBe(assistant.content);
		expect(transformedAssistant.content).toEqual([redactedBlock, textBlock, toolCallBlock]);
		expect(transformedAssistant.content[0]).not.toBe(redactedBlock);
		expect(transformedAssistant.content[1]).not.toBe(textBlock);
		expect(transformedAssistant.content[2]).not.toBe(toolCallBlock);
	});

	it("drops cross-model redacted thinking instead of replaying opaque provider state", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "[Reasoning redacted]",
						thinkingSignature: "opaque-redacted-payload",
						redacted: true,
					},
					{ type: "text", text: "previous answer" },
				],
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((message) => message.role === "assistant") as AssistantMessage;

		expect(assistantMsg.content).toEqual([{ type: "text", text: "previous answer" }]);
	});

	it("adds synthetic tool results for trailing orphaned tool calls", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "read the file", timestamp: Date.now() },
			makeAssistantMessage([
				{
					type: "toolCall",
					id: "call_123|fc_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			]),
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const lastMessage = result[result.length - 1];

		expect(lastMessage).toMatchObject({
			role: "toolResult",
			toolCallId: "call_123_fc_123",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "No result provided" }],
		});
	});

	it("adds synthetic results only for trailing tool calls that are still missing results", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run commands", timestamp: Date.now() },
			makeAssistantMessage([
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" } },
				{ type: "toolCall", id: "call_2|fc_2", name: "bash", arguments: { command: "pwd" } },
			]),
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const syntheticResults = result.filter((message) => message.role === "toolResult" && message.isError);

		expect(syntheticResults).toHaveLength(1);
		expect(syntheticResults[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_2_fc_2",
			toolName: "bash",
			content: [{ type: "text", text: "No result provided" }],
		});
	});

	it("moves a delayed normalized tool result ahead of an intervening user turn", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "read", timestamp: Date.now() },
			makeAssistantMessage([{ type: "toolCall", id: "call|one", name: "read", arguments: {} }]),
			{ role: "user", content: "while waiting", timestamp: Date.now() },
			{
				role: "toolResult",
				toolCallId: "call|one",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);

		expect(
			result.map((message) =>
				message.role === "toolResult" ? `${message.role}:${message.toolCallId}` : message.role,
			),
		).toEqual(["user", "assistant", "toolResult:call_one", "user"]);
	});

	it("pairs each multi-call tool use with one real result or one synthetic error", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run", timestamp: Date.now() },
			makeAssistantMessage([
				{ type: "toolCall", id: "first", name: "read", arguments: {} },
				{ type: "toolCall", id: "second", name: "bash", arguments: {} },
			]),
			{
				role: "toolResult",
				toolCallId: "first",
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);

		expect(
			result
				.slice(1)
				.map((message) => (message.role === "toolResult" ? [message.toolCallId, message.isError] : message.role)),
		).toEqual(["assistant", ["first", false], ["second", true]]);
	});

	it("does not attach an earlier orphaned reused ID result to a later call", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "reused",
				toolName: "read",
				content: [{ type: "text", text: "orphan" }],
				isError: false,
				timestamp: Date.now(),
			},
			{ role: "user", content: "second", timestamp: Date.now() },
			makeAssistantMessage([{ type: "toolCall", id: "reused", name: "read", arguments: {} }]),
			{
				role: "toolResult",
				toolCallId: "reused",
				toolName: "read",
				content: [{ type: "text", text: "second result" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const toolResults = result.filter((message) => message.role === "toolResult");

		expect(toolResults.map((message) => message.content)).toEqual([
			[{ type: "text", text: "orphan" }],
			[{ type: "text", text: "second result" }],
		]);
		expect(result.map((message) => message.role)).toEqual(["toolResult", "user", "assistant", "toolResult"]);
	});

	it("does not let a later reused-ID result repair the prior assistant turn", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "first", timestamp: Date.now() },
			makeAssistantMessage([{ type: "toolCall", id: "reused", name: "read", arguments: {} }]),
			{ role: "user", content: "second", timestamp: Date.now() },
			makeAssistantMessage([{ type: "toolCall", id: "reused", name: "read", arguments: {} }]),
			{
				role: "toolResult",
				toolCallId: "reused",
				toolName: "read",
				content: [{ type: "text", text: "second result" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const toolResults = result.filter((message) => message.role === "toolResult");

		expect(toolResults.map((message) => [message.isError, message.content])).toEqual([
			[true, [{ type: "text", text: "No result provided" }]],
			[false, [{ type: "text", text: "second result" }]],
		]);
		expect(result.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
			"assistant",
			"toolResult",
		]);
	});
});
