import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { streamSimple as streamMistral } from "../src/api/mistral-conversations.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { streamSimple as streamPi } from "../src/api/pi-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";
import { APPLY_PATCH_TOOL, HISTORY, makeModel, PATCH } from "./model-switch-replay-fixtures.ts";

const bedrockModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

async function captureBedrockPayload(context: Context): Promise<unknown> {
	let payload: unknown;
	const stream = streamBedrock(bedrockModel, context, {
		cacheRetention: "none",
		signal: AbortSignal.abort(),
		onPayload: (candidate) => {
			payload = candidate;
			return candidate;
		},
	});
	for await (const event of stream) {
		if (event.type === "error") break;
	}
	if (payload === undefined) {
		throw new Error("Bedrock payload was not captured");
	}
	return payload;
}

async function captureMistralPayload(context: Context): Promise<unknown> {
	let payload: unknown;
	const stream = streamMistral(makeModel("mistral-conversations", "mistral", "mistral-target"), context, {
		apiKey: "fake-api-key",
		onPayload: (candidate) => {
			payload = candidate;
			throw new Error("payload captured before transport");
		},
	});
	await stream.result();
	if (payload === undefined) {
		throw new Error("Mistral payload was not captured");
	}
	return payload;
}

async function capturePiPayload(context: Context): Promise<unknown> {
	let payload: unknown;
	const stream = streamPi(makeModel("pi-messages", "pi", "pi-target"), context, {
		apiKey: "fake-api-key",
		onPayload: (candidate) => {
			payload = candidate;
			throw new Error("payload captured before transport");
		},
	});
	await stream.result();
	if (payload === undefined) {
		throw new Error("pi-messages payload was not captured");
	}
	return payload;
}

describe("model-switch replay policy table", () => {
	it("row azure-openai-responses: shared responses converter applies the truth table", () => {
		// Given: azure-openai-responses.ts:259 delegates to convertResponsesMessages.
		const model = makeModel("azure-openai-responses", "azure-openai", "gpt-target");

		// When
		const customReplay = convertResponsesMessages(
			model,
			{ messages: HISTORY, tools: [APPLY_PATCH_TOOL] },
			new Set(["openai"]),
		);
		const functionReplay = convertResponsesMessages(model, { messages: HISTORY }, new Set(["openai"]));

		// Then
		expect(customReplay).toMatchObject([
			{ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: PATCH },
			{ type: "custom_tool_call_output", call_id: "call_patch", name: "apply_patch", output: "Done!" },
		]);
		expect(functionReplay).toMatchObject([
			{
				type: "function_call",
				call_id: "call_patch",
				name: "apply_patch",
				arguments: JSON.stringify({ input: PATCH }),
			},
			{ type: "function_call_output", call_id: "call_patch", output: "Done!" },
		]);
	});

	it("row openai-codex-responses: shared responses converter applies the truth table", () => {
		// Given: openai-codex-responses.ts:506 delegates to convertResponsesMessages.
		const model = makeModel("openai-codex-responses", "openai", "gpt-target");

		// When
		const customReplay = convertResponsesMessages(
			model,
			{ messages: HISTORY, tools: [APPLY_PATCH_TOOL] },
			new Set(["openai"]),
		);
		const functionReplay = convertResponsesMessages(model, { messages: HISTORY }, new Set(["openai"]));

		// Then
		expect(customReplay).toMatchObject([
			{ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: PATCH },
			{ type: "custom_tool_call_output", call_id: "call_patch", name: "apply_patch", output: "Done!" },
		]);
		expect(functionReplay).toMatchObject([
			{
				type: "function_call",
				call_id: "call_patch",
				name: "apply_patch",
				arguments: JSON.stringify({ input: PATCH }),
			},
			{ type: "function_call_output", call_id: "call_patch", output: "Done!" },
		]);
	});

	it("row google-vertex: shared google converter preserves the stored name and JSON args", () => {
		// Given: google-vertex.ts:476 delegates to google-shared convertMessages.
		const model = makeModel("google-vertex", "google-vertex", "gemini-target");

		// When
		const replay = convertGoogleMessages(model, { messages: HISTORY });

		// Then
		expect(replay).toMatchObject([
			{ role: "model", parts: [{ functionCall: { name: "apply_patch", args: { input: PATCH } } }] },
			{ role: "user", parts: [{ functionResponse: { name: "apply_patch", response: { output: "Done!" } } }] },
		]);
	});

	it("row bedrock-converse-stream: native toolUse block preserves the stored name and JSON args", async () => {
		// Given
		const context: Context = { messages: HISTORY };

		// When
		const payload = await captureBedrockPayload(context);

		// Then
		expect(payload).toMatchObject({
			messages: [
				{
					role: "assistant",
					content: [{ toolUse: { toolUseId: "call_patch", name: "apply_patch", input: { input: PATCH } } }],
				},
				{
					role: "user",
					content: [{ toolResult: { toolUseId: "call_patch", content: [{ text: "Done!" }] } }],
				},
			],
		});
	});

	it("row mistral-conversations: tool call entry preserves the stored name and JSON args", async () => {
		// Given
		const context: Context = { messages: HISTORY };

		// When
		const payload = await captureMistralPayload(context);

		// Then: the stored tool NAME is preserved; the id normalization to "callpatch"
		// is the pre-existing createMistralToolCallIdNormalizer behavior, not a rename.
		expect(payload).toMatchObject({
			messages: [
				{
					role: "assistant",
					toolCalls: [
						{
							id: "callpatch",
							type: "function",
							function: { name: "apply_patch", arguments: JSON.stringify({ input: PATCH }) },
						},
					],
				},
				{
					role: "tool",
					toolCallId: "callpatch",
					name: "apply_patch",
					content: [{ type: "text", text: "Done!" }],
				},
			],
		});
	});

	it("row pi-messages: pass-through keeps the stored apply_patch call and result intact", async () => {
		// Given
		const context: Context = { messages: HISTORY };

		// When
		const payload = await capturePiPayload(context);

		// Then
		expect(payload).toMatchObject({
			context: {
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_patch", name: "apply_patch", arguments: { input: PATCH } }],
					},
					{
						role: "toolResult",
						toolCallId: "call_patch",
						toolName: "apply_patch",
						content: [{ type: "text", text: "Done!" }],
					},
				],
			},
		});
	});
});
