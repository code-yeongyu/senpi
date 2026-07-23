import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	BLOCKED_IMAGE_PLACEHOLDER,
	convertToLlmForTransport,
	elideOldImages,
	IMAGE_ELISION_PLACEHOLDER,
	TRANSPORT_IMAGE_BUDGET_BYTES,
} from "../src/core/messages.ts";

function img(data: string) {
	return { type: "image", data, mimeType: "image/png" } as const;
}

function toolResult(...blocks: unknown[]): Message {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: blocks,
	} as unknown as Message;
}

function agentToolResult(...blocks: unknown[]): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: blocks,
		timestamp: 1,
	} as unknown as AgentMessage;
}

describe("elideOldImages", () => {
	it("returns the same reference when there are no images", () => {
		const messages = [{ role: "user", content: "hi" }] as unknown as Message[];

		expect(elideOldImages(messages, { budgetBytes: 0, alwaysKeepNewest: 0 })).toBe(messages);
	});

	it("returns the same reference when all images fit the budget", () => {
		const messages = [toolResult(img("A".repeat(100)))];

		expect(elideOldImages(messages, { budgetBytes: 1000, alwaysKeepNewest: 0 })).toBe(messages);
	});

	it("uses a hard recency cutoff after the budget is exceeded", () => {
		const messages = [
			toolResult(img("A".repeat(60))),
			toolResult(img("B".repeat(60))),
			toolResult(img("C".repeat(60))),
		];

		const result = elideOldImages(messages, { budgetBytes: 130, alwaysKeepNewest: 0 });

		expect(result.map((message) => (message.content as Array<{ type: string }>)[0].type)).toEqual([
			"text",
			"image",
			"image",
		]);
		expect((result[0].content as Array<{ type: string; text?: string }>)[0].text).toBe(IMAGE_ELISION_PLACEHOLDER);
	});

	it("keeps the newest block regardless of size and charges it to the budget", () => {
		const messages = [
			toolResult(img("A".repeat(10))),
			toolResult(img("B".repeat(10))),
			toolResult(img("HUGE".repeat(100))),
		];

		const result = elideOldImages(messages, { budgetBytes: 50, alwaysKeepNewest: 1 });

		expect(result.map((message) => (message.content as Array<{ type: string }>)[0].type)).toEqual([
			"text",
			"text",
			"image",
		]);
	});

	it("preserves sibling text blocks verbatim when eliding", () => {
		const messages = [
			toolResult({ type: "text", text: "Read image file [image/png]" }, img("A".repeat(60))),
			toolResult(img("B".repeat(60))),
		];

		const result = elideOldImages(messages, { budgetBytes: 60, alwaysKeepNewest: 0 });

		expect(result[0].content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "text", text: IMAGE_ELISION_PLACEHOLDER },
		]);
	});

	it("dedupes consecutive placeholders within one message", () => {
		const messages = [
			{ role: "user", content: [img("A".repeat(60)), img("B".repeat(60))] } as unknown as Message,
			toolResult(img("C".repeat(60))),
		];

		const result = elideOldImages(messages, { budgetBytes: 60, alwaysKeepNewest: 0 });

		expect(result[0].content).toEqual([{ type: "text", text: IMAGE_ELISION_PLACEHOLDER }]);
	});

	it("treats later blocks within a message as newer", () => {
		const messages = [{ role: "user", content: [img("A".repeat(60)), img("B".repeat(60))] } as unknown as Message];

		const result = elideOldImages(messages, { budgetBytes: 60, alwaysKeepNewest: 0 });
		const content = result[0].content as Array<{ type: string; data?: string }>;

		expect(content.map((block) => block.type)).toEqual(["text", "image"]);
		expect(content[1].data).toBe("B".repeat(60));
	});

	it("tracks repeated image objects by block position", () => {
		const repeated = img("A".repeat(60));
		const messages = [{ role: "user", content: [repeated, repeated] } as unknown as Message];

		const result = elideOldImages(messages, { budgetBytes: 60, alwaysKeepNewest: 0 });

		expect((result[0].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["text", "image"]);
	});

	it("leaves assistant messages and string-content user messages untouched", () => {
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
		} as unknown as Message;
		const stringUser = { role: "user", content: "plain" } as unknown as Message;
		const messages = [assistant, stringUser, toolResult(img("A".repeat(10)))];

		expect(elideOldImages(messages, { budgetBytes: 1000, alwaysKeepNewest: 0 })).toBe(messages);
	});

	it("exposes the documented production budget", () => {
		expect(TRANSPORT_IMAGE_BUDGET_BYTES).toBe(24 * 1024 * 1024);
	});

	it("uses the production budget by default", () => {
		const messages = [toolResult(img("A".repeat(10)))];

		expect(elideOldImages(messages)).toBe(messages);
	});

	it("keeps one newest image by default", () => {
		const messages = [toolResult(img("A")), toolResult(img("B"))];

		const result = elideOldImages(messages, { budgetBytes: 0 });

		expect(result.map((message) => (message.content as Array<{ type: string }>)[0].type)).toEqual(["text", "image"]);
	});
});

describe("convertToLlmForTransport", () => {
	it("passes convertToLlm output through when images fit", () => {
		const messages = [agentToolResult({ type: "text", text: "n" }, img("A".repeat(10)))];

		const result = convertToLlmForTransport(messages, {
			blockImages: false,
			budgetBytes: 1000,
			alwaysKeepNewest: 0,
		});

		expect(result[0].content).toEqual([{ type: "text", text: "n" }, img("A".repeat(10))]);
	});

	it("elides old images and keeps the newest when over budget", () => {
		const messages = [agentToolResult(img("A".repeat(60))), agentToolResult(img("B".repeat(60)))];

		const result = convertToLlmForTransport(messages, {
			blockImages: false,
			budgetBytes: 60,
			alwaysKeepNewest: 1,
		});

		expect((result[0].content as Array<{ type: string; text?: string }>)[0]).toEqual({
			type: "text",
			text: IMAGE_ELISION_PLACEHOLDER,
		});
		expect((result[1].content as Array<{ type: string }>)[0].type).toBe("image");
	});

	it("makes blockImages override budget options across messages while preserving text and dedupe", () => {
		const messages = [
			agentToolResult({ type: "text", text: "first" }, img("A".repeat(10)), img("B".repeat(10))),
			agentToolResult(img("C".repeat(10)), { type: "text", text: "last" }),
		];

		const result = convertToLlmForTransport(messages, {
			blockImages: true,
			budgetBytes: 0,
			alwaysKeepNewest: 1,
		});

		expect(result[0].content).toEqual([
			{ type: "text", text: "first" },
			{ type: "text", text: BLOCKED_IMAGE_PLACEHOLDER },
		]);
		expect(result[1].content).toEqual([
			{ type: "text", text: BLOCKED_IMAGE_PLACEHOLDER },
			{ type: "text", text: "last" },
		]);
	});
});
