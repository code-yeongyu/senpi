import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { hasVisibleAssistantContent, hasVisibleText } from "../src/utils/visible-text.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("hasVisibleText", () => {
	it.each(["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"])(
		"treats format-character-only text %j as invisible",
		(text) => {
			expect(hasVisibleText(text)).toBe(false);
		},
	);

	it("treats whitespace-only text as invisible", () => {
		expect(hasVisibleText(" \t\n\r")).toBe(false);
	});

	it("keeps emoji ZWJ sequences visible", () => {
		expect(hasVisibleText("👨‍👩‍👧‍👦")).toBe(true);
	});

	it("keeps letters mixed with zero-width spaces visible", () => {
		expect(hasVisibleText("\u200bvisible\u200b")).toBe(true);
	});

	it("treats an empty string as invisible", () => {
		expect(hasVisibleText("")).toBe(false);
	});
});

describe("hasVisibleAssistantContent", () => {
	it("accepts visible text or a tool call and rejects thinking plus invisible text", () => {
		expect(hasVisibleAssistantContent(assistant([{ type: "text", text: "answer" }]))).toBe(true);
		expect(
			hasVisibleAssistantContent(
				assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }]),
			),
		).toBe(true);
		expect(
			hasVisibleAssistantContent(
				assistant([
					{ type: "text", text: "\u200b" },
					{ type: "thinking", thinking: "private" },
				]),
			),
		).toBe(false);
	});
});
