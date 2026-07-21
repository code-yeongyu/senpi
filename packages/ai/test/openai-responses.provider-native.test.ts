import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, Context, ProviderNativeContent } from "../src/types.ts";

function createSseResponse(events: unknown[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(`${body}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("OpenAI Responses provider-native content blocks", () => {
	it("reconciles a completed provider-native item over its partial added frame", async () => {
		// Given: the real Responses lifecycle where web-search action metadata arrives only on done.
		const model = getModel("openai", "gpt-5.4");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		const partialWebSearchCall = {
			type: "web_search_call",
			id: "ws_partial",
			status: "in_progress",
		};
		const completedWebSearchCall = {
			...partialWebSearchCall,
			status: "completed",
			action: { type: "search", query: "senpi parity", queries: null },
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			createSseResponse([
				{ type: "response.output_item.added", item: partialWebSearchCall, output_index: 0 },
				{ type: "response.output_item.done", item: completedWebSearchCall, output_index: 0 },
				{
					type: "response.completed",
					response: {
						id: "resp_partial_native",
						status: "completed",
						output: [completedWebSearchCall],
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							total_tokens: 0,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		);

		// When: the adapter completes the response stream.
		const assistantMessage = await streamOpenAIResponses(model, context, { apiKey: "test-key" }).result();

		// Then: the persisted native block is the final provider item, not the partial placeholder.
		expect(assistantMessage.content).toContainEqual({
			type: "providerNative",
			subtype: "web_search_call",
			raw: completedWebSearchCall,
		});
	});

	it("surfaces unknown output items as providerNative content", async () => {
		const model = getModel("openai", "gpt-5.4");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const webSearchCall = {
			type: "web_search_call",
			id: "ws_1",
			status: "completed",
			query: "hello",
		};
		const fileSearchCall = {
			type: "file_search_call",
			id: "fs_1",
			status: "completed",
			query: "world",
		};

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			createSseResponse([
				{ type: "response.output_item.added", item: webSearchCall, output_index: 0 },
				{ type: "response.output_item.done", item: webSearchCall, output_index: 0 },
				{ type: "response.output_item.added", item: fileSearchCall, output_index: 1 },
				{ type: "response.output_item.done", item: fileSearchCall, output_index: 1 },
				{
					type: "response.completed",
					response: {
						id: "resp_native",
						status: "completed",
						output: [webSearchCall, fileSearchCall],
						usage: {
							input_tokens: 3,
							output_tokens: 2,
							total_tokens: 5,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		);

		const stream = streamOpenAIResponses(model, context, { apiKey: "test-key" });
		const assistantMessage = await stream.result();

		const providerNativeBlocks = assistantMessage.content.filter(
			(block): block is ProviderNativeContent => block.type === "providerNative",
		);

		expect(providerNativeBlocks).toHaveLength(2);
		expect(providerNativeBlocks).toEqual([
			{ type: "providerNative", subtype: "web_search_call", raw: webSearchCall },
			{ type: "providerNative", subtype: "file_search_call", raw: fileSearchCall },
		]);
	});

	it("skips providerNative blocks when converting assistant replay messages", () => {
		const model = getModel("openai", "gpt-5.4");
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "kept" },
				{ type: "providerNative", subtype: "web_search_call", raw: { type: "web_search_call", id: "ws_1" } },
				{ type: "providerNative", subtype: "file_search_call", raw: { type: "file_search_call", id: "fs_1" } },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
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

		const replay = convertResponsesMessages(
			model,
			{
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }, assistantMessage],
			},
			new Set(["openai", "openai-codex", "opencode"]),
		);

		const assistantReplayItems = replay.filter((item) => item.type === "message");
		expect(assistantReplayItems).toHaveLength(1);
		expect(assistantReplayItems[0]).toMatchObject({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "kept" }],
		});
	});
});
