import type { Context, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	coldSeedImageText,
	frameHistoryImages,
	MAX_REPLAYED_HISTORY_IMAGE_BYTES,
} from "../src/core/extensions/builtin/anthropic-subscription/cold-seed-images.ts";

const sdkName = (name: string): string => name;

function image(seed: string, bytes = 16): { type: "image"; mimeType: string; data: string } {
	return { type: "image", mimeType: "image/png", data: Buffer.alloc(bytes, seed).toString("base64") };
}

function toolImage(index: number, seed = `img-${index}`, bytes?: number): Message {
	return {
		role: "toolResult",
		toolCallId: `shot-${index}`,
		toolName: "screenshot",
		content: [image(seed, bytes)],
		isError: false,
		timestamp: index,
	};
}

function nativeIndexes(history: Context["messages"]): number[] {
	const replaced = frameHistoryImages(history, sdkName);
	return history.flatMap((message, index) => {
		const content = replaced.get(index) ?? (message.role === "toolResult" ? message.content : []);
		return Array.isArray(content) && content.some((entry) => (entry as { type?: string }).type === "image")
			? [index]
			: [];
	});
}

describe("senpi#1977 native-frame cold seed image policy", () => {
	it("sends identical image bytes once and references them afterwards", () => {
		const history = [toolImage(0, "same"), toolImage(1, "same")];

		const replaced = frameHistoryImages(history, sdkName);

		expect(replaced.get(0)).toEqual([history[0]?.role === "toolResult" ? history[0].content[0] : undefined]);
		expect(replaced.get(1)).toEqual([
			{
				type: "text",
				text: coldSeedImageText.duplicate(
					{ kind: "tool", toolName: "screenshot", toolCallId: "shot-1" },
					{ kind: "tool", toolName: "screenshot", toolCallId: "shot-0" },
				),
			},
		]);
	});

	it("cuts nothing below twice the target, then the oldest in steps of the target", () => {
		const history = (count: number) => Array.from({ length: count }, (_, index) => toolImage(index));
		const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);

		expect(nativeIndexes(history(15))).toEqual(range(0, 15));
		expect(nativeIndexes(history(16))).toEqual(range(8, 16));
		// Appending keeps every earlier decision until the next step.
		expect(nativeIndexes(history(23))).toEqual(range(8, 23));
		expect(nativeIndexes(history(24))).toEqual(range(16, 24));
	});

	it("cuts tool images before the user's own upload", () => {
		const upload: Message = { role: "user", content: [image("upload")], timestamp: 0 };
		const history = [upload, ...Array.from({ length: 15 }, (_, index) => toolImage(index + 1))];

		const native = nativeIndexes(history);

		expect(native).toContain(0);
		expect(native).toEqual([0, ...Array.from({ length: 7 }, (_, index) => index + 9)]);
	});

	it("caps the image bytes, cutting the oldest in half-cap steps", () => {
		const size = 6 * 1024 * 1024;
		const history = Array.from({ length: 4 }, (_, index) => toolImage(index, `big-${index}`, size));
		expect(4 * size).toBeGreaterThan(MAX_REPLAYED_HISTORY_IMAGE_BYTES);

		const replaced = frameHistoryImages(history, sdkName);

		expect(nativeIndexes(history)).toEqual([2, 3]);
		expect(replaced.get(0)).toEqual([
			{
				type: "text",
				text: coldSeedImageText.capped({ kind: "tool", toolName: "screenshot", toolCallId: "shot-0" }),
			},
		]);
	});
});
