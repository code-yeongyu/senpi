import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, ProviderNativeContent } from "../src/types.ts";

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

	it("preserves unknown tool-use-shaped blocks when input deltas arrive", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};
		const unknownBlock = {
			type: "metadata_tool_use",
			id: "meta_1",
			payload: "verbatim",
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
				data: JSON.stringify({ type: "content_block_start", index: 0, content_block: unknownBlock }),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"unexpected":true}' },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { input_tokens: 3, output_tokens: 1 },
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		}).result();

		expect(result.content[0]).toEqual({
			type: "providerNative",
			subtype: "metadata_tool_use",
			raw: unknownBlock,
		});
	});

	it("finalizes server tool input when the stream ends before content_block_stop", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
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
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "server_tool_use", id: "srvu_1", name: "web_search", input: {} },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"query":"interrupted"}' },
				}),
			},
		]);

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.content[0]).toEqual({
			type: "providerNative",
			subtype: "server_tool_use",
			raw: { type: "server_tool_use", id: "srvu_1", name: "web_search", input: { query: "interrupted" } },
		});
		expect(result.content[0]).not.toHaveProperty("partialJson");
	});
});
