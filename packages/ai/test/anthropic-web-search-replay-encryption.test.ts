import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import "../src/providers/register-builtins.ts";
import { streamSimple } from "../src/stream.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

type CapturedMessage = { readonly role: string; readonly content: unknown };

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

async function captureMessages(
	model: Model<"anthropic-messages">,
	messages: Context["messages"],
): Promise<readonly CapturedMessage[]> {
	let capturedMessages: readonly CapturedMessage[] | undefined;
	const stream = streamSimple(
		{
			...model,
			baseUrl: "http://127.0.0.1:9",
			// The localhost override only captures the payload; this test exercises
			// first-party replay semantics rather than endpoint capability detection.
			compat: { ...model.compat, supportsWebSearch: true },
		},
		{ messages },
		{
			apiKey: "fake-key",
			onPayload: (payload) => {
				if (isRecord(payload) && Array.isArray(payload.messages)) {
					capturedMessages = payload.messages.flatMap((message) => {
						if (!isRecord(message) || typeof message.role !== "string") return [];
						return [{ role: message.role, content: message.content }];
					});
				}
				return payload;
			},
		},
	);

	await stream.result();
	if (!capturedMessages) throw new Error("Expected payload capture");
	return capturedMessages;
}

describe("Anthropic web search replay encryption", () => {
	it("preserves encrypted_content byte-for-byte in replayed web search results", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			content: [
				{
					type: "providerNative",
					subtype: "web_search_tool_result",
					raw: {
						type: "web_search_tool_result",
						tool_use_id: "srvu_1",
						content: [
							{
								type: "web_search_result",
								title: "Example",
								url: "https://example.com",
								page_age: "2026-07-07",
								encrypted_content: "opaque-ciphertext",
							},
						],
					},
				},
				{ type: "text", text: "kept" },
			],
			usage,
			stopReason: "stop",
			timestamp: 1,
		};

		const messages = await captureMessages(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "follow up", timestamp: 2 },
		]);

		const assistantPayload = messages.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([
			{
				type: "web_search_tool_result",
				tool_use_id: "srvu_1",
				content: [
					{
						type: "web_search_result",
						title: "Example",
						url: "https://example.com",
						page_age: "2026-07-07",
						encrypted_content: "opaque-ciphertext",
					},
				],
			},
			{ type: "text", text: "kept" },
		]);
	});
});
