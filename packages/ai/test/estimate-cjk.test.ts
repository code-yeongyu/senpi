import { describe, expect, it } from "vitest";
import type { AssistantMessage, UserMessage } from "../src/types.ts";
import { estimateMessageTokens, estimateTextAndImageContentTokens, estimateTextTokens } from "../src/utils/estimate.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("token estimates count CJK, kana and Hangul characters as one token each (senpi#3032)", () => {
	it.each([
		{ script: "Chinese", text: "上下文窗口".repeat(200), expected: 1000 },
		{ script: "Japanese kana", text: "こんにちは".repeat(200), expected: 1000 },
		{ script: "Korean Hangul", text: "안녕하세요".repeat(200), expected: 1000 },
		{ script: "fullwidth punctuation", text: "，。！？：".repeat(200), expected: 1000 },
		{ script: "Latin (unchanged)", text: "abcd".repeat(250), expected: 250 },
		{ script: "mixed", text: "hello 世界", expected: 4 },
	])("$script", ({ text, expected }) => {
		expect(estimateTextTokens(text)).toBe(expected);
	});

	it("applies to user content blocks, assistant text, thinking and tool-call arguments", () => {
		const user: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "请总结这段代码".repeat(10) }],
			timestamp: 0,
		};
		expect(estimateTextAndImageContentTokens(user.content)).toBe(70);
		expect(estimateMessageTokens(user)).toBe(70);

		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "好的".repeat(10) },
				{ type: "thinking", thinking: "思考".repeat(10) },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "文件" } },
			],
			api: "openai-completions",
			provider: "faux",
			model: "faux",
			usage,
			stopReason: "toolUse",
			timestamp: 0,
		};
		// weighted characters: 20 x 4 (text) + 20 x 4 (thinking) + "read" (4) + '{"path":"文件"}' (13, two of them wide: +6) = 183 -> ceil(183 / 4) = 46
		expect(estimateMessageTokens(assistant)).toBe(46);
	});
});
