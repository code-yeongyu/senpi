import { describe, expect, it } from "vitest";
import { downgradeUnsupportedImages } from "../src/api/transform-messages.ts";
import type { Api, Message, Model } from "../src/types.ts";

const DESCRIBING_TOOL = "describe_image";
const IMAGE = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

function makeModel(input: ("text" | "image")[]): Model<Api> {
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

function conversation(): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: "what is this" }, IMAGE], timestamp: 1 },
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "Read image file [image/png]" }, IMAGE, IMAGE],
			isError: false,
			timestamp: 2,
		},
	];
}

function texts(message: Message): string[] {
	if (!Array.isArray(message.content)) throw new Error("Expected structured content.");
	return message.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`));
}

// senpi#7233: a model without image input was told only that the image was omitted, never that a
// tool could describe it. The placeholder wording stays as it was for callers that name no tool
// (pinned by transform-messages-video.test.ts and google-shared-gemini3-unsigned-tool-call.test.ts).
describe("image downgrade with a describing tool (senpi#7233)", () => {
	it("names the tool where a user image and a run of tool-result images were", () => {
		const [user, toolResult] = downgradeUnsupportedImages(conversation(), makeModel(["text"]), {
			imageDescriptionTool: DESCRIBING_TOOL,
		});

		const [userText, userPlaceholder, ...userRest] = texts(user);
		expect(userText).toBe("what is this");
		expect(userPlaceholder).toContain(DESCRIBING_TOOL);
		expect(userRest).toEqual([]);
		const [toolText, toolPlaceholder, ...toolRest] = texts(toolResult);
		expect(toolText).toBe("Read image file [image/png]");
		expect(toolPlaceholder).toContain(DESCRIBING_TOOL);
		expect(toolRest).toEqual([]);
		// senpi#7320: a pasted image has no file path, so its placeholder cannot be the tool result's.
		expect(userPlaceholder).not.toBe(toolPlaceholder);
	});

	it("leaves the images of a model with image input in place", () => {
		const messages = conversation();

		const result = downgradeUnsupportedImages(messages, makeModel(["text", "image"]), {
			imageDescriptionTool: DESCRIBING_TOOL,
		});

		expect(result.map(texts)).toEqual([
			["what is this", "<image>"],
			["Read image file [image/png]", "<image>", "<image>"],
		]);
	});
});
