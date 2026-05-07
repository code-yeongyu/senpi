import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, ProviderNativeContent } from "../src/types.js";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response, onCreate?: (params: unknown) => void): Anthropic {
	return {
		messages: {
			create: (params: unknown) => {
				onCreate?.(params);
				return {
					asResponse: async () => response,
				};
			},
		},
	} as Anthropic;
}

describe("Anthropic provider-native content blocks", () => {
	it("surfaces unknown content blocks as providerNative content", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		const serverToolUseBlock = {
			type: "server_tool_use",
			id: "srvu_1",
			name: "web_search",
			input: { query: "hi" },
		};
		const webSearchToolResultBlock = {
			type: "web_search_tool_result",
			tool_use_id: "srvu_1",
			content: [
				{
					type: "web_search_result",
					title: "Example",
					url: "https://example.com",
					encrypted_content: "enc",
				},
			],
		};

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 3,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({ type: "content_block_start", index: 0, content_block: serverToolUseBlock }),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({ type: "content_block_start", index: 1, content_block: webSearchToolResultBlock }),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 3,
						output_tokens: 7,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		const nativeBlocks = result.content.filter(
			(block): block is ProviderNativeContent => block.type === "providerNative",
		);
		expect(nativeBlocks).toHaveLength(2);
		expect(nativeBlocks[0]).toEqual({ type: "providerNative", subtype: "server_tool_use", raw: serverToolUseBlock });
		expect(nativeBlocks[1]).toEqual({
			type: "providerNative",
			subtype: "web_search_tool_result",
			raw: webSearchToolResultBlock,
		});
	});

	it("skips providerNative blocks when converting assistant messages for replay", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const assistantContent: Context["messages"][number] = {
			role: "assistant",
			content: [
				{ type: "text", text: "kept" },
				{ type: "providerNative", subtype: "server_tool_use", raw: { type: "server_tool_use", id: "srvu_1" } },
				{
					type: "providerNative",
					subtype: "web_search_tool_result",
					raw: { type: "web_search_tool_result", tool_use_id: "srvu_1" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
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
		};

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }, assistantContent],
		};

		let capturedPayload: unknown;
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_replay",
						usage: {
							input_tokens: 2,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 2,
						output_tokens: 2,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response, (params) => {
				capturedPayload = params;
			}),
		});
		await stream.result();

		const payload = capturedPayload as {
			messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
		};
		const assistantMessage = payload.messages.find((message) => message.role === "assistant");
		expect(assistantMessage).toBeDefined();
		expect(assistantMessage?.content).toEqual([{ type: "text", text: "kept" }]);
	});
});
