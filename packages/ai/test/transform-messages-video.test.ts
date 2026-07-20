import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Api, Message, Model } from "../src/types.ts";

function makeModel(input: ("text" | "image" | "video")[]): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.com",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	} as Model<Api>;
}

const VIDEO_BLOCK = { type: "image" as const, data: "AAAA", mimeType: "video/mp4" };
const IMAGE_BLOCK = { type: "image" as const, data: "BBBB", mimeType: "image/png" };

function userMessage(): Message {
	return {
		role: "user",
		content: [{ type: "text", text: "look at this" }, VIDEO_BLOCK, IMAGE_BLOCK],
		timestamp: Date.now(),
	};
}

function toolResultMessage(): Message {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read_video",
		content: [{ type: "text", text: "attached" }, VIDEO_BLOCK],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("transformMessages video downgrade", () => {
	it("preserves video blocks for models with the video modality", () => {
		const result = transformMessages([userMessage(), toolResultMessage()], makeModel(["text", "image", "video"]));
		const user = result[0];
		expect(user.role).toBe("user");
		expect(user.content).toContainEqual(VIDEO_BLOCK);
		const toolResult = result.find((m) => m.role === "toolResult");
		expect(toolResult?.content).toContainEqual(VIDEO_BLOCK);
	});

	it("replaces video blocks with placeholders for image-only models, keeping images", () => {
		const result = transformMessages([userMessage(), toolResultMessage()], makeModel(["text", "image"]));
		const user = result[0];
		expect(user.content).not.toContainEqual(VIDEO_BLOCK);
		expect(user.content).toContainEqual(IMAGE_BLOCK);
		expect(user.content).toContainEqual({
			type: "text",
			text: "(video omitted: model does not support video input)",
		});
		const toolResult = result.find((m) => m.role === "toolResult");
		expect(toolResult?.content).not.toContainEqual(VIDEO_BLOCK);
		expect(toolResult?.content).toContainEqual({
			type: "text",
			text: "(tool video omitted: model does not support video input)",
		});
	});

	it("replaces both video and image blocks for text-only models", () => {
		const result = transformMessages([userMessage()], makeModel(["text"]));
		const user = result[0];
		const content = user.content as Array<{ type: string; text?: string }>;
		expect(content.every((b) => b.type === "text")).toBe(true);
		expect(content.map((b) => b.text)).toEqual([
			"look at this",
			"(video omitted: model does not support video input)",
			"(image omitted: model does not support images)",
		]);
	});
});
