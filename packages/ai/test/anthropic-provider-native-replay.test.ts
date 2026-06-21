import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import "../src/providers/register-builtins.ts";
import { streamSimple } from "../src/stream.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface CapturedAnthropicMessage {
	readonly role: string;
	readonly content: unknown;
}

interface CapturedAnthropicPayload {
	readonly messages?: readonly CapturedAnthropicMessage[];
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePayload(value: unknown): CapturedAnthropicPayload {
	if (!isRecord(value)) {
		return {};
	}
	const messages = value.messages;
	if (!Array.isArray(messages)) {
		return {};
	}
	return {
		messages: messages.flatMap((message) => {
			if (!isRecord(message) || typeof message.role !== "string") {
				return [];
			}
			return [{ role: message.role, content: message.content }];
		}),
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	overrides?: Partial<AssistantMessage>,
): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		content,
		usage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	messages: Context["messages"],
	options?: SimpleStreamOptions,
): Promise<CapturedAnthropicPayload> {
	let capturedPayload: CapturedAnthropicPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};
	const stream = streamSimple(
		payloadCaptureModel,
		{ messages },
		{
			...options,
			apiKey: "fake-key",
			onPayload: (payload) => {
				capturedPayload = parsePayload(payload);
				return payload;
			},
		},
	);

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic provider-native replay", () => {
	it("preserves same-model server tool blocks around signed thinking", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const serverToolUse = { type: "server_tool_use", id: "srvu_1", name: "web_search", input: { query: "hi" } };
		const webSearchToolResult = {
			type: "web_search_tool_result",
			tool_use_id: "srvu_1",
			content: [
				{ type: "web_search_result", title: "Example", url: "https://example.com", encrypted_content: "enc" },
			],
		};
		const assistant = assistantMessage(
			[
				{ type: "providerNative", subtype: "server_tool_use", raw: serverToolUse },
				{ type: "providerNative", subtype: "web_search_tool_result", raw: webSearchToolResult },
				{ type: "thinking", thinking: "protected thinking", thinkingSignature: "sig_1" },
				{ type: "text", text: "kept" },
				{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "README.md" } },
			],
			{ stopReason: "toolUse" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: 2,
			},
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([
			serverToolUse,
			webSearchToolResult,
			{ type: "thinking", thinking: "protected thinking", signature: "sig_1" },
			{ type: "text", text: "kept" },
			{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } },
		]);
	});

	it("drops cross-provider provider-native blocks", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const assistant = assistantMessage(
			[
				{ type: "providerNative", subtype: "web_search_call", raw: { type: "web_search_call", id: "ws_1" } },
				{ type: "text", text: "kept" },
			],
			{
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
			},
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "follow up", timestamp: 2 },
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([{ type: "text", text: "kept" }]);
	});
});
