import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildPromptBlocks } from "../src/core/extensions/builtin/claude-sdk-oauth/prompt-bridge.ts";
import {
	buildDeltaPromptBlocks,
	type SentMessage,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";

const RAW_STRING_ENTRY = "\n(OmO) auto-formatted file";

const ISSUE_7660_CONTENT = [
	{ type: "text", text: "ok" },
	RAW_STRING_ENTRY,
	{ type: "text", text: "LSP errors detected" },
];

function toolResult(content: unknown, timestamp = 1): SentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "edit",
		content,
		isError: false,
		timestamp,
	} as SentMessage;
}

function user(content: unknown, timestamp = 2): SentMessage {
	return { role: "user", content, timestamp } as SentMessage;
}

function promptContext(...messages: SentMessage[]): Context {
	return { messages } as Context;
}

function imageBlocks(blocks: readonly { type: string }[]): unknown[] {
	return blocks.filter((block) => block.type === "image");
}

function textOf(blocks: readonly { type: string; text?: string }[]): string[] {
	return blocks.filter((block) => block.type === "text").map((block) => block.text ?? "");
}

describe("claude-sdk-oauth content blocks (#7660)", () => {
	it("maps a raw string toolResult entry to text on flatten and delta bridges", () => {
		const messages = [toolResult(ISSUE_7660_CONTENT), user("continue")];

		const prompt = buildPromptBlocks(promptContext(...messages));
		expect(imageBlocks(prompt)).toEqual([]);
		expect(textOf(prompt)).toContain(RAW_STRING_ENTRY);

		const delta = buildDeltaPromptBlocks(messages);
		expect(imageBlocks(delta)).toEqual([]);
		expect(textOf(delta)).toContain(RAW_STRING_ENTRY);
	});

	it("keeps a well-formed image as an image with media_type and data", () => {
		const content = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
		const expected = { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } };

		expect(buildPromptBlocks(promptContext(user(content)))).toContainEqual(expected);
		expect(buildDeltaPromptBlocks([user(content)])).toContainEqual(expected);
	});

	it("maps an image missing data to a text placeholder instead of a broken image", () => {
		const content = [{ type: "image", mimeType: "image/png" }];
		const prompt = buildPromptBlocks(promptContext(user(content)));
		const delta = buildDeltaPromptBlocks([user(content)]);

		expect(imageBlocks(prompt)).toEqual([]);
		expect(imageBlocks(delta)).toEqual([]);
		expect(textOf(prompt)).toContain("[image block omitted: missing data]");
		expect(textOf(delta)).toContain("[image block omitted: missing data]");
	});

	it("maps an unknown object type to a placeholder that includes the type", () => {
		const content = [{ type: "tool_use", id: "x" }];
		const prompt = buildPromptBlocks(promptContext(user(content)));
		const delta = buildDeltaPromptBlocks([user(content)]);

		expect(imageBlocks(prompt)).toEqual([]);
		expect(imageBlocks(delta)).toEqual([]);
		expect(textOf(prompt)).toContain("[unsupported content block omitted: tool_use]");
		expect(textOf(delta)).toContain("[unsupported content block omitted: tool_use]");
	});

	it("maps a text block with non-string text to a placeholder", () => {
		const content = [{ type: "text", text: 42 }];
		const prompt = buildPromptBlocks(promptContext(user(content)));
		const delta = buildDeltaPromptBlocks([user(content)]);

		expect(imageBlocks(prompt)).toEqual([]);
		expect(imageBlocks(delta)).toEqual([]);
		expect(textOf(prompt)).toContain("[unsupported content block omitted: text]");
		expect(textOf(delta)).toContain("[unsupported content block omitted: text]");
	});

	it("keeps each bridge's historical whole-content empty-string shape", () => {
		expect(buildDeltaPromptBlocks([user("")])).toEqual([{ type: "text", text: "" }]);
		// prompt-bridge has always skipped the empty text block (and, with no text, appends its image note)
		expect(buildPromptBlocks(promptContext(user("")))).not.toContainEqual({ type: "text", text: "" });
	});

	it("names an unsupported image media type instead of claiming missing data", () => {
		const content = [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }];
		const prompt = buildPromptBlocks(promptContext(user(content)));
		expect(imageBlocks(prompt)).toEqual([]);
		expect(textOf(prompt)).toContain("[image block omitted: unsupported media type image/svg+xml]");
	});

	it("keeps hasText false for whitespace-only text so buildPromptBlocks still appends the image note", () => {
		const blocks = buildPromptBlocks(
			promptContext(
				user([
					{ type: "text", text: "   " },
					{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
				]),
			),
		);

		expect(blocks).toContainEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
		});
		expect(textOf(blocks)).toContain("   ");
		expect(textOf(blocks)).toContain("(see attached image)");
	});
});
