import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import type { Context, Model } from "../src/types.ts";

const model = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
} as Model<"openai-codex-responses">;

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function convertToolImage(data: string) {
	const context: Context = {
		messages: [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_image|fc_image",
						name: "image_tool",
						arguments: {},
					},
				],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
				usage: zeroUsage(),
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call_image|fc_image",
				toolName: "image_tool",
				content: [{ type: "image", data, mimeType: "image/png" }],
				isError: false,
				timestamp: 2,
			},
		],
		tools: [],
	};

	return convertResponsesMessages(model, context, new Set(["openai-codex"]));
}

describe("issue #1260 Responses tool-result image data URLs", () => {
	it("adds exactly one data URL prefix to raw base64", () => {
		expect(convertToolImage("QUJD")).toMatchObject([
			{ type: "function_call", call_id: "call_image", name: "image_tool" },
			{
				type: "function_call_output",
				call_id: "call_image",
				output: [{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,QUJD" }],
			},
		]);
	});

	it("preserves an already-prefixed canonical image data URL", () => {
		const dataUrl = "data:image/png;base64,QUJD";
		expect(convertToolImage(dataUrl)).toMatchObject([
			{ type: "function_call", call_id: "call_image", name: "image_tool" },
			{
				type: "function_call_output",
				call_id: "call_image",
				output: [{ type: "input_image", detail: "auto", image_url: dataUrl }],
			},
		]);
	});
});
