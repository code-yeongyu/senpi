import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Tool, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Ported from the upstream-deleted deferred-tools.test.ts: fallback replay must decide deferral from
// tool-result markers that survive Anthropic conversion, not from discarded pre-fallback results.

interface AnthropicToolPayload {
	name: string;
	defer_loading?: boolean;
}

interface AnthropicContentBlock {
	type: string;
	text?: string;
	tool_use_id?: string;
	content?: string | Array<{ type: string; tool_name?: string }>;
	source?: {
		type: string;
		media_type: string;
		data: string;
	};
	cache_control?: { type: string };
	is_error?: boolean;
}

interface AnthropicPayload {
	tools?: AnthropicToolPayload[];
	messages: Array<{ content: string | AnthropicContentBlock[] }>;
}

class PayloadCaptured extends Error {}

function makeTool(name: string): Tool {
	return {
		name,
		description: `The ${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
	};
}

function makeAssistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function makeToolResult(addedToolNames: string[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "base_tool",
		content: [{ type: "text", text: "done" }],
		addedToolNames,
		isError: false,
		timestamp: 3,
	};
}

function makeContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Hello", timestamp: 1 },
			makeAssistantToolCall(),
			makeToolResult(["late_tool"]),
			{ role: "user", content: "Hello", timestamp: 4 },
		],
		tools: [makeTool("base_tool"), makeTool("late_tool")],
	};
}

async function capturePayload(context: Context): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	const model = { ...getModel("anthropic", "claude-opus-4-6"), baseUrl: "http://127.0.0.1:9" };
	const stream = streamSimple(model, normalizeContext(context), {
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

function findToolResultContent(payload: AnthropicPayload): AnthropicContentBlock[] {
	for (const message of payload.messages) {
		if (Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")) {
			return message.content;
		}
	}
	throw new Error("No tool result in payload");
}

function findToolResults(payload: AnthropicPayload): AnthropicContentBlock[] {
	return findToolResultContent(payload).filter((block) => block.type === "tool_result");
}

describe("Anthropic deferred tools", () => {
	it("preserves tool output as sibling content after emitting references", async () => {
		const context = makeContext();
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [
			{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} },
			{ type: "toolCall", id: "call_2", name: "base_tool", arguments: {} },
		];
		const firstResult = context.messages[2] as ToolResultMessage;
		firstResult.content = [
			{ type: "text", text: "work completed" },
			{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
		];
		context.messages.splice(3, 0, {
			...makeToolResult([]),
			toolCallId: "call_2",
			content: [{ type: "text", text: "second result" }],
		});

		const payload = await capturePayload(context);

		expect(findToolResultContent(payload)).toMatchObject([
			{
				type: "tool_result",
				tool_use_id: "call_1",
				content: [{ type: "tool_reference", tool_name: "late_tool" }],
			},
			{ type: "tool_result", tool_use_id: "call_2", content: "second result" },
			{ type: "text", text: "work completed" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
			},
			{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
		]);
	});

	it("keeps a tool immediate when it was used before its marker", async () => {
		const context = makeContext();
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [{ type: "toolCall", id: "call_1", name: "late_tool", arguments: {} }];
		const payload = await capturePayload(context);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.tools?.every((tool) => !tool.defer_loading)).toBe(true);
	});

	it("keeps a tool immediate when its marker rides a discarded fallback result", async () => {
		const context = makeContext();
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [
			{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} },
			{
				type: "providerNative",
				subtype: "fallback",
				raw: { type: "fallback", from: { model: "claude-opus-4-6" }, to: { model: "claude-opus-4-6" } },
			},
			{ type: "text", text: "served after fallback" },
		];

		const payload = await capturePayload(context);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.tools?.every((tool) => !tool.defer_loading)).toBe(true);
	});

	it("still defers a tool when its marker also rides a surviving result", async () => {
		const context = makeContext();
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [
			{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} },
			{
				type: "providerNative",
				subtype: "fallback",
				raw: { type: "fallback", from: { model: "claude-opus-4-6" }, to: { model: "claude-opus-4-6" } },
			},
			{ type: "toolCall", id: "call_2", name: "base_tool", arguments: {} },
		];
		context.messages.splice(3, 0, { ...makeToolResult(["late_tool"]), toolCallId: "call_2" });

		const payload = await capturePayload(context);

		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool", defer_loading: true }]);
		expect(findToolResults(payload)).toEqual([
			{
				type: "tool_result",
				tool_use_id: "call_2",
				content: [{ type: "tool_reference", tool_name: "late_tool" }],
				is_error: false,
			},
		]);
	});
});
