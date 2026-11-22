import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { elidedImageIds, imageContentId } from "../src/core/image-elision-placeholder.ts";
import {
	BLOCKED_IMAGE_PLACEHOLDER,
	convertToLlmForTransport,
	elideOldImages,
	IMAGE_ELISION_PLACEHOLDER,
	TRANSPORT_IMAGE_BUDGET_BYTES,
} from "../src/core/messages.ts";

const ELIDED = expect.stringMatching(/^\[Image elided: .+ \(image ids?: [0-9a-f]{12}(, [0-9a-f]{12})*\)$/);

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
		expect((result[0].content as Array<{ type: string; text?: string }>)[0].text).toEqual(ELIDED);
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

	it("keeps a single newest image even when it exceeds the budget", () => {
		const messages = [toolResult(img("HUGE".repeat(100)))];

		const result = elideOldImages(messages, { budgetBytes: 50, alwaysKeepNewest: 1 });

		expect(result).toBe(messages);
		expect(((result[0].content as Array<{ type: string; data?: string }>)[0].data ?? "").length).toBe(400);
	});

	it("preserves sibling text blocks verbatim when eliding", () => {
		const messages = [
			toolResult({ type: "text", text: "Read image file [image/png]" }, img("A".repeat(60))),
			toolResult(img("B".repeat(60))),
		];

		const result = elideOldImages(messages, { budgetBytes: 60, alwaysKeepNewest: 0 });

		expect(result[0].content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "text", text: ELIDED },
		]);
	});

	it("dedupes consecutive placeholders within one message", () => {
		const messages = [
			{ role: "user", content: [img("A".repeat(60)), img("B".repeat(60))] } as unknown as Message,
			toolResult(img("C".repeat(60))),
		];

		const result = elideOldImages(messages, { budgetBytes: 60, alwaysKeepNewest: 0 });

		expect(result[0].content).toEqual([
			{
				type: "text",
				text: `${IMAGE_ELISION_PLACEHOLDER} (image ids: ${imageContentId("A".repeat(60))}, ${imageContentId("B".repeat(60))})`,
			},
		]);
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

	it("elides old images while preserving recent history and the current turn", () => {
		const messages = [
			{ role: "user", content: [img("old-a")] },
			{ role: "assistant", content: [{ type: "text", text: "analyzed a" }] },
			{ role: "user", content: [img("old-b")] },
			{ role: "assistant", content: [{ type: "text", text: "analyzed b" }] },
			{ role: "user", content: [img("recent-history")] },
			{ role: "assistant", content: [{ type: "text", text: "analyzed recent" }] },
			{ role: "user", content: [img("current-a"), img("current-b")] },
		] as unknown as Message[];

		const result = elideOldImages(messages, {
			budgetBytes: Number.POSITIVE_INFINITY,
			alwaysKeepNewest: 0,
			maxHistoricalImages: 1,
		});

		expect(result[0].content).toEqual([{ type: "text", text: ELIDED }]);
		expect(result[2].content).toEqual([{ type: "text", text: ELIDED }]);
		expect(result[4].content).toEqual([img("recent-history")]);
		expect(result[6].content).toEqual([img("current-a"), img("current-b")]);
	});

	it("preserves tool result identity when an historical image is elided", () => {
		const messages = [
			toolResult(img("old"), { type: "text", text: "OCR result" }),
			{ role: "assistant", content: [{ type: "text", text: "used OCR" }] },
			{ role: "user", content: [{ type: "text", text: "continue" }] },
		] as unknown as Message[];

		const result = elideOldImages(messages, {
			budgetBytes: Number.POSITIVE_INFINITY,
			alwaysKeepNewest: 0,
			maxHistoricalImages: 0,
		});

		expect(result[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [
				{ type: "text", text: ELIDED },
				{ type: "text", text: "OCR result" },
			],
		});
	});

	it("keeps existing behavior when no historical image limit is configured", () => {
		const messages = [
			{ role: "user", content: [img("old")] },
			{ role: "assistant", content: [{ type: "text", text: "analyzed" }] },
			{ role: "user", content: [img("current")] },
		] as unknown as Message[];

		expect(
			elideOldImages(messages, {
				budgetBytes: Number.POSITIVE_INFINITY,
				alwaysKeepNewest: 0,
			}),
		).toBe(messages);
	});
});

describe("elideOldImages across a growing session (senpi#2768)", () => {
	const budget = 1000;
	const elidedIndexes = (result: Message[]): number[] =>
		result.flatMap((message, index) =>
			(message.content as Array<{ type: string; text?: string }>).some(
				(block) => elidedImageIds(block.text ?? "") !== undefined,
			)
				? [index]
				: [],
		);

	it("moves the cutoff in steps, so a turn that only adds an image resends earlier images unchanged", () => {
		const history: Message[] = [];
		let previous: number[] = [];
		let changedRequests = 0;
		for (let turn = 0; turn < 40; turn++) {
			history.push(toolResult(img(String.fromCharCode(65 + (turn % 26)).repeat(100))));
			const result = elideOldImages(history, { budgetBytes: budget, alwaysKeepNewest: 1 });
			const elided = elidedIndexes(result);
			const keptBytes = result.reduce(
				(sum, message) =>
					sum +
					(message.content as Array<{ type: string; data?: string }>)
						.filter((block) => block.type === "image")
						.reduce((bytes, block) => bytes + (block.data?.length ?? 0), 0),
				0,
			);
			expect(keptBytes).toBeLessThanOrEqual(budget);
			expect(previous.every((index) => elided.includes(index))).toBe(true);
			if (elided.length !== previous.length) changedRequests++;
			previous = elided;
		}
		// 30 requests run over budget; the cutoff moves once per half-budget step, not on each of them.
		expect(changedRequests).toBeLessThanOrEqual(7);
	});

	it("moves the historical-image limit in steps too", () => {
		const history: Message[] = [];
		let previous: number[] = [];
		let changedRequests = 0;
		for (let turn = 0; turn < 30; turn++) {
			history.push(
				{ role: "user", content: [img(`shot-${turn}`)] } as unknown as Message,
				{ role: "assistant", content: [{ type: "text", text: `analyzed ${turn}` }] } as unknown as Message,
			);
			const result = elideOldImages(history, { budgetBytes: Number.POSITIVE_INFINITY, maxHistoricalImages: 8 });
			const elided = elidedIndexes(result);
			expect(history.length / 2 - elided.length).toBeLessThanOrEqual(8);
			expect(previous.every((index) => elided.includes(index))).toBe(true);
			if (elided.length !== previous.length) changedRequests++;
			previous = elided;
		}
		expect(changedRequests).toBeLessThanOrEqual(6);
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
			text: ELIDED,
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
