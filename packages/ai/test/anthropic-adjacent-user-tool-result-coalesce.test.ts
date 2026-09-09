import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Context, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";

type WireBlock = {
	type: string;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
	text?: string;
};

type WireMessage = {
	role: string;
	content: WireBlock[] | string;
};

type WirePayload = {
	messages: WireMessage[];
};

function createSseResponse(): Response {
	const events = [
		[
			"message_start",
			{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
		["message_stop", { type: "message_stop" }],
	] as const;
	return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function toolResultMessage(toolCallId: string, toolName: string, text = "result"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function makeTool(name: string): Tool {
	return { name, description: name, parameters: Type.Object({}) };
}

describe("Anthropic adjacent user and toolResult coalescence", () => {
	it("coalesces a user message immediately following a toolResult into a single alternating user turn", async () => {
		let captured: WirePayload | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: unknown) => {
						captured = params as WirePayload;
						return { asResponse: async () => createSseResponse() };
					},
				},
			},
		} as Anthropic;

		const context: Context = {
			messages: [
				userMessage("first prompt"),
				fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "toolu_1" })], {
					stopReason: "toolUse",
				}),
				toolResultMessage("toolu_1", "bash", "file1.txt"),
				userMessage("continue after interrupted turn"),
			],
			tools: [makeTool("bash")],
		};

		const stream = streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, {
			apiKey: "fake-key",
			client,
		});
		await stream.result();

		expect(captured).toBeDefined();
		const messages = captured!.messages;
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

		const lastUserMsg = messages[2];
		expect(Array.isArray(lastUserMsg.content)).toBe(true);
		const contentBlocks = lastUserMsg.content as WireBlock[];
		expect(contentBlocks).toHaveLength(2);
		expect(contentBlocks[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_1",
		});
		expect(contentBlocks[1]).toMatchObject({
			type: "text",
			text: "continue after interrupted turn",
		});
	});

	it("preserves standalone string user messages as string content", async () => {
		let captured: WirePayload | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: unknown) => {
						captured = params as WirePayload;
						return { asResponse: async () => createSseResponse() };
					},
				},
			},
		} as Anthropic;

		const context: Context = {
			messages: [userMessage("standalone prompt")],
		};

		const stream = streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, {
			apiKey: "fake-key",
			client,
			cacheRetention: "none",
		});
		await stream.result();

		expect(captured?.messages).toEqual([{ role: "user", content: "standalone prompt" }]);
	});

	it("coalesces consecutive user text messages into a single user turn", async () => {
		let captured: WirePayload | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: unknown) => {
						captured = params as WirePayload;
						return { asResponse: async () => createSseResponse() };
					},
				},
			},
		} as Anthropic;

		const context: Context = {
			messages: [
				userMessage("hello"),
				userMessage("world"),
				fauxAssistantMessage([{ type: "text", text: "acknowledged" }], { stopReason: "stop" }),
				userMessage("turn 2 part 1"),
				userMessage("turn 2 part 2"),
			],
		};

		const stream = streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, {
			apiKey: "fake-key",
			client,
		});
		await stream.result();

		expect(captured).toBeDefined();
		const messages = captured!.messages;
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

		const firstMsg = messages[0];
		expect(Array.isArray(firstMsg.content)).toBe(true);
		expect((firstMsg.content as WireBlock[]).map((b) => b.text)).toEqual(["hello", "world"]);

		const lastMsg = messages[2];
		expect(Array.isArray(lastMsg.content)).toBe(true);
		expect((lastMsg.content as WireBlock[]).map((b) => b.text)).toEqual(["turn 2 part 1", "turn 2 part 2"]);
	});
});
