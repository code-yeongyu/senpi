import type { AssistantMessage, Context, ImageContent, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	coldSeedImageText,
	MAX_REPLAYED_HISTORY_IMAGES,
	type ReplayedImageOrigin,
} from "../src/core/extensions/builtin/anthropic-subscription/cold-seed-images.ts";
import {
	buildPromptBlocks,
	mapPiToolNameToSdk,
} from "../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import type { ContentBlockParam } from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	buildDeltaPromptBlocks,
	type SentMessage,
} from "../src/core/extensions/builtin/anthropic-subscription/session-sync.ts";

const SCREENSHOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=";
const READ = mapPiToolNameToSdk("read");
const USER: ReplayedImageOrigin = { kind: "user" };
const SEE_ATTACHED = "(see attached image)";

function image(data: string): ImageContent {
	return { type: "image", mimeType: "image/png", data };
}

function distinctImage(n: number): ImageContent {
	return image(Buffer.from(`distinct screenshot ${n}`).toString("base64"));
}

function assistantRead(id: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "shot.png" } }],
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function readOf(id: string, content: ImageContent, timestamp: number): Message[] {
	return [
		assistantRead(id, timestamp),
		{ role: "toolResult", toolCallId: id, toolName: "read", content: [content], isError: false, timestamp },
	];
}

function upload(content: ImageContent, timestamp = 0): Message {
	return { role: "user", content: [{ type: "text", text: "Here is a screenshot" }, content], timestamp };
}

function say(text: string, timestamp: number): Message {
	return { role: "user", content: text, timestamp };
}

function images(blocks: readonly ContentBlockParam[]): string[] {
	return blocks.flatMap((block) =>
		block.type === "image" && block.source.type === "base64" ? [block.source.data] : [],
	);
}

function texts(blocks: readonly ContentBlockParam[]): string[] {
	return blocks.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

function countText(blocks: readonly ContentBlockParam[], text: string): number {
	return texts(blocks).filter((candidate) => candidate === text).length;
}

function labelsBeforeImages(blocks: readonly ContentBlockParam[]): string[] {
	const labels: string[] = [];
	let lastText = "";
	for (const block of blocks) {
		if (block.type === "text") lastText = block.text;
		if (block.type === "image") labels.push(lastText);
	}
	return labels;
}

function rebuild(messages: Message[]): ContentBlockParam[] {
	return buildPromptBlocks({ messages } satisfies Context);
}

describe("anthropic-subscription cold seed replays tool-read images as tool output (#2490)", () => {
	it("willowite's reproduction: one upload plus five reads replays one user image, not six", () => {
		const messages = [
			upload(image(SCREENSHOT)),
			...Array.from({ length: 5 }, (_, n) => readOf(`read-${n}`, image(SCREENSHOT), n + 1)).flat(),
			say("Continue.", 10),
		];

		const blocks = rebuild(messages);

		expect(images(blocks)).toEqual([SCREENSHOT]);
		expect(labelsBeforeImages(blocks)).toEqual(["Here is a screenshot"]);
		expect(countText(blocks, SEE_ATTACHED)).toBe(0);
		const read: ReplayedImageOrigin = { kind: "tool", toolName: READ, toolCallId: "read-0" };
		expect(countText(blocks, coldSeedImageText.duplicate(read, USER))).toBe(5);
	});

	it("keeps the image count constant when the agent keeps re-reading across repeated cold seeds", () => {
		const messages: Message[] = [upload(image(SCREENSHOT)), say("What is on it?", 1)];
		const imageCounts: number[] = [];
		const userAttachmentNotes: number[] = [];

		for (let round = 0; round < 4; round++) {
			const blocks = rebuild(messages);
			imageCounts.push(images(blocks).length);
			userAttachmentNotes.push(countText(blocks, SEE_ATTACHED));
			messages.push(...readOf(`reread-${round}`, image(SCREENSHOT), 10 + round), say("And now?", 20 + round));
		}

		expect(imageCounts).toEqual([1, 1, 1, 1]);
		expect(userAttachmentNotes).toEqual([0, 0, 0, 0]);
	});

	it("labels a tool image as tool output and sends identical reads once, then refers back to it", () => {
		const messages = [
			say("Open the screenshot", 0),
			...Array.from({ length: 5 }, (_, n) => readOf(`read-${n}`, image(SCREENSHOT), n + 1)).flat(),
			say("Describe it", 10),
		];

		const blocks = rebuild(messages);

		expect(images(blocks)).toEqual([SCREENSHOT]);
		expect(labelsBeforeImages(blocks)).toEqual([coldSeedImageText.toolOutput(READ)]);
		expect(countText(blocks, SEE_ATTACHED)).toBe(0);
		const first: ReplayedImageOrigin = { kind: "tool", toolName: READ, toolCallId: "read-0" };
		const repeat = coldSeedImageText.duplicate({ ...first, toolCallId: "read-1" }, first);
		expect(countText(blocks, repeat)).toBe(4);
	});

	it("caps distinct historical images, keeping the user's upload and the most recent reads", () => {
		const reads = MAX_REPLAYED_HISTORY_IMAGES + 3;
		const messages = [
			upload(image(SCREENSHOT)),
			...Array.from({ length: reads }, (_, n) => readOf(`read-${n}`, distinctImage(n), n + 1)).flat(),
			say("Compare them", 100),
		];

		const replayed = images(rebuild(messages));

		expect(replayed).toHaveLength(MAX_REPLAYED_HISTORY_IMAGES);
		expect(replayed[0]).toBe(SCREENSHOT);
		const newestReads = Array.from({ length: MAX_REPLAYED_HISTORY_IMAGES - 1 }, (_, i) => reads - 1 - i).reverse();
		expect(replayed.slice(1)).toEqual(newestReads.map((n) => distinctImage(n).data));
		const dropped = Array.from({ length: reads - newestReads.length }, (_, n) =>
			coldSeedImageText.capped({ kind: "tool", toolName: READ, toolCallId: `read-${n}` }),
		);
		expect(texts(rebuild(messages))).toEqual(expect.arrayContaining(dropped));
	});

	it("drops a broken image reference with a note and still ends with the user's message", () => {
		const messages = [
			say("Open the screenshots", 0),
			...readOf("empty", image(""), 1),
			...readOf("garbled", image("@@not base64@@"), 2),
			...readOf("good", image(SCREENSHOT), 3),
			say("Which ones loaded?", 4),
		];

		const blocks = rebuild(messages);

		expect(images(blocks)).toEqual([SCREENSHOT]);
		for (const id of ["empty", "garbled"]) {
			expect(texts(blocks)).toContain(
				coldSeedImageText.unreadable({ kind: "tool", toolName: READ, toolCallId: id }),
			);
		}
		expect(blocks.at(-1)).toEqual({ type: "text", text: "Which ones loaded?" });
	});

	it("dedupes wrapped, URL-safe or unpadded encodings of the same bytes and sends them canonical", () => {
		const wrapped = SCREENSHOT.replace(/(.{20})/g, "$1\n");
		const urlSafe = SCREENSHOT.replaceAll("+", "-").replaceAll("/", "_");
		const unpadded = SCREENSHOT.replace(/=+$/, "");
		const blocks = rebuild([
			upload(image(SCREENSHOT)),
			...readOf("wrapped", image(wrapped), 1),
			...readOf("url-safe", image(urlSafe), 2),
			...readOf("unpadded", image(unpadded), 3),
			say("Same one?", 4),
		]);

		expect(images(blocks)).toEqual([SCREENSHOT]);
		expect(images(rebuild([say("Open it", 0), ...readOf("wrapped", image(wrapped), 1), say("Well?", 2)]))).toEqual([
			SCREENSHOT,
		]);
		for (const id of ["wrapped", "url-safe", "unpadded"]) {
			const origin: ReplayedImageOrigin = { kind: "tool", toolName: READ, toolCallId: id };
			expect(texts(blocks)).toContain(coldSeedImageText.duplicate(origin, USER));
		}
	});

	it("still sends a fresh re-attachment in the new user message, and leaves resume deltas untouched", () => {
		const history = [upload(image(SCREENSHOT)), ...readOf("read-0", image(SCREENSHOT), 1)];
		const fresh = upload(image(SCREENSHOT), 5);

		expect(images(rebuild([...history, fresh]))).toEqual([SCREENSHOT, SCREENSHOT]);
		const sent = [...history, fresh].filter((message): message is SentMessage => message.role !== "assistant");
		expect(images(buildDeltaPromptBlocks(sent))).toEqual([SCREENSHOT, SCREENSHOT, SCREENSHOT]);
	});
});
