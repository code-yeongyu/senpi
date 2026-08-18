import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, Context, ProviderNativeContent } from "../src/types.ts";

const VALID_IMAGE_BASE64 = "iVBORw0KGgo=";
const MAX_NATIVE_IMAGE_BASE64_CHARS = 24 * 1024 * 1024;

function createSseResponse(events: unknown[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(`${body}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function terminalResponse(output: unknown[], id = "resp_native") {
	return {
		type: "response.completed",
		response: {
			id,
			status: "completed",
			output,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				total_tokens: 0,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
}

async function streamFixture(events: unknown[]): Promise<AssistantMessage> {
	const model = getModel("openai", "gpt-5.4");
	const context: Context = {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
	vi.spyOn(globalThis, "fetch").mockResolvedValue(createSseResponse(events));
	return streamOpenAIResponses(model, context, { apiKey: "test-key" }).result();
}

function providerNativeBlocks(message: AssistantMessage): ProviderNativeContent[] {
	return message.content.filter((block): block is ProviderNativeContent => block.type === "providerNative");
}

describe("OpenAI Responses provider-native content blocks", () => {
	it("reconciles image_generation_call added and done frames into one final block", async () => {
		const added = { type: "image_generation_call", id: "ig_1", status: "in_progress" };
		const done = { ...added, status: "completed", result: VALID_IMAGE_BASE64 };

		const message = await streamFixture([
			{ type: "response.output_item.added", item: added, output_index: 0 },
			{ type: "response.output_item.done", item: done, output_index: 0 },
			terminalResponse([done]),
		]);

		expect(providerNativeBlocks(message)).toEqual([
			{ type: "providerNative", subtype: "image_generation_call", raw: done },
		]);
	});

	it("preserves a nonempty revised_prompt on a completed image", async () => {
		const done = {
			type: "image_generation_call",
			id: "ig_prompt",
			status: "completed",
			result: VALID_IMAGE_BASE64,
			revised_prompt: "A small blue square",
		};

		const message = await streamFixture([
			{ type: "response.output_item.done", item: done, output_index: 0 },
			terminalResponse([done]),
		]);

		expect(providerNativeBlocks(message)[0]?.raw).toEqual(done);
	});

	it("omits missing and empty revised_prompt values", async () => {
		const withoutPrompt = {
			type: "image_generation_call",
			id: "ig_no_prompt",
			status: "completed",
			result: VALID_IMAGE_BASE64,
		};
		const emptyPrompt = { ...withoutPrompt, id: "ig_empty_prompt", revised_prompt: "   " };

		const message = await streamFixture([
			{ type: "response.output_item.done", item: withoutPrompt, output_index: 0 },
			{ type: "response.output_item.done", item: emptyPrompt, output_index: 1 },
			terminalResponse([withoutPrompt, emptyPrompt]),
		]);

		expect(providerNativeBlocks(message).map((block) => block.raw)).toEqual([
			withoutPrompt,
			{ type: "image_generation_call", id: "ig_empty_prompt", status: "completed", result: VALID_IMAGE_BASE64 },
		]);
	});

	it("marks nullable, missing, empty, and invalid completed results as malformed without retaining result", async () => {
		const items = [
			{ type: "image_generation_call", id: "ig_null", status: "completed", result: null },
			{ type: "image_generation_call", id: "ig_missing", status: "completed" },
			{ type: "image_generation_call", id: "ig_empty", status: "completed", result: "" },
			{ type: "image_generation_call", id: "ig_invalid", status: "completed", result: "not base64" },
		];

		const message = await streamFixture([
			...items.map((item, output_index) => ({ type: "response.output_item.done", item, output_index })),
			terminalResponse(items),
		]);

		expect(providerNativeBlocks(message).map((block) => block.raw)).toEqual(
			items.map((item) => ({ type: "image_generation_call", id: item.id, status: "malformed" })),
		);
	});

	it("keeps failed images as short status blocks and preserves unknown statuses verbatim", async () => {
		const failed = {
			type: "image_generation_call",
			id: "ig_failed",
			status: "failed",
			result: VALID_IMAGE_BASE64,
			revised_prompt: "must not survive",
		};
		const unknown = {
			type: "image_generation_call",
			id: "ig_unknown",
			status: "provider_specific_state",
			result: VALID_IMAGE_BASE64,
		};

		const message = await streamFixture([
			{ type: "response.output_item.done", item: failed, output_index: 0 },
			{ type: "response.output_item.done", item: unknown, output_index: 1 },
			terminalResponse([failed, unknown]),
		]);

		expect(message.stopReason).toBe("stop");
		expect(providerNativeBlocks(message).map((block) => block.raw)).toEqual([
			{ type: "image_generation_call", id: "ig_failed", status: "failed" },
			{ type: "image_generation_call", id: "ig_unknown", status: "provider_specific_state" },
		]);
	});

	it("ignores partial image events entirely", async () => {
		const message = await streamFixture([
			{
				type: "response.image_generation_call.partial_image",
				item_id: "ig_partial",
				output_index: 0,
				partial_image_index: 0,
				partial_image_b64: VALID_IMAGE_BASE64,
			},
			terminalResponse([]),
		]);

		expect(providerNativeBlocks(message)).toEqual([]);
		expect(JSON.stringify(message.content)).not.toContain(VALID_IMAGE_BASE64);
	});

	it("backfills a final image from terminal output when output_item.done is absent", async () => {
		const added = { type: "image_generation_call", id: "ig_backfill", status: "in_progress" };
		const completed = {
			...added,
			status: "completed",
			result: VALID_IMAGE_BASE64,
			revised_prompt: "Backfilled prompt",
		};

		const message = await streamFixture([
			{ type: "response.output_item.added", item: added, output_index: 0 },
			terminalResponse([completed]),
		]);

		expect(providerNativeBlocks(message)).toEqual([
			{ type: "providerNative", subtype: "image_generation_call", raw: completed },
		]);
	});

	it("rejects oversized aggregate image results without retaining base64 in final content", async () => {
		const firstResult = "A".repeat(MAX_NATIVE_IMAGE_BASE64_CHARS / 2);
		const secondResult = "A".repeat(MAX_NATIVE_IMAGE_BASE64_CHARS / 2 + 4);
		const first = { type: "image_generation_call", id: "ig_large_1", status: "completed", result: firstResult };
		const second = { type: "image_generation_call", id: "ig_large_2", status: "completed", result: secondResult };

		const message = await streamFixture([
			{ type: "response.output_item.done", item: first, output_index: 0 },
			{ type: "response.output_item.done", item: second, output_index: 1 },
			terminalResponse([first, second]),
		]);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Native image generation results exceed the 24 MiB base64 limit");
		expect(providerNativeBlocks(message).map((block) => block.raw)).toEqual([
			{ type: "image_generation_call", id: "ig_large_1", status: "malformed" },
		]);
	});

	it("surfaces unknown output items as providerNative content", async () => {
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

		const message = await streamFixture([
			{ type: "response.output_item.added", item: webSearchCall, output_index: 0 },
			{ type: "response.output_item.done", item: webSearchCall, output_index: 0 },
			{ type: "response.output_item.added", item: fileSearchCall, output_index: 1 },
			{ type: "response.output_item.done", item: fileSearchCall, output_index: 1 },
			terminalResponse([webSearchCall, fileSearchCall]),
		]);

		expect(providerNativeBlocks(message)).toEqual([
			{ type: "providerNative", subtype: "web_search_call", raw: webSearchCall },
			{ type: "providerNative", subtype: "file_search_call", raw: fileSearchCall },
		]);
	});

	it("still drops image providerNative blocks when converting assistant replay messages", () => {
		const model = getModel("openai", "gpt-5.4");
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "kept" },
				{ type: "providerNative", subtype: "web_search_call", raw: { type: "web_search_call", id: "ws_1" } },
				{
					type: "providerNative",
					subtype: "image_generation_call",
					raw: { type: "image_generation_call", id: "ig_replay", status: "completed", result: VALID_IMAGE_BASE64 },
				},
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
