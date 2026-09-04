import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, StopReason, ToolResultMessage } from "../src/types.ts";
import { dropFailedAssistantTurns } from "../src/utils/drop-failed-assistant-turns.ts";

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: StopReason,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function toolResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "search",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function userMessage(text: string, timestamp: number): Message {
	return { role: "user", content: text, timestamp };
}

describe("dropFailedAssistantTurns", () => {
	it("drops error and aborted assistants and their orphaned tool results", () => {
		// Given a history whose error and abort turns each declared one tool call
		const messages: Message[] = [
			userMessage("find the bug", 1),
			assistantMessage(
				[
					{ type: "text", text: "PARTIAL" },
					{ type: "toolCall", id: "call-error", name: "search", arguments: { q: 1 } },
				],
				"error",
				2,
			),
			toolResult("call-error", "partial output", 3),
			assistantMessage(
				[
					{ type: "text", text: "HALF-DONE" },
					{ type: "toolCall", id: "call-aborted", name: "search", arguments: { q: 2 } },
				],
				"aborted",
				4,
			),
			toolResult("call-aborted", "aborted output", 5),
			userMessage("next", 6),
		];

		// When the failed turns are dropped
		const result = dropFailedAssistantTurns(messages);

		// Then only the two user messages survive, in order
		expect(result).toEqual([userMessage("find the bug", 1), userMessage("next", 6)]);
	});

	it("keeps a tool result whose id is re-declared by a later kept assistant", () => {
		// Given an errored turn and a kept turn re-using the same tool call id
		const messages: Message[] = [
			userMessage("retry", 1),
			assistantMessage([{ type: "toolCall", id: "call-reused", name: "search", arguments: { q: 1 } }], "error", 2),
			assistantMessage([{ type: "toolCall", id: "call-reused", name: "search", arguments: { q: 2 } }], "toolUse", 3),
			toolResult("call-reused", "good output", 4),
			userMessage("thanks", 5),
		];

		const result = dropFailedAssistantTurns(messages);

		expect(result).toEqual([
			userMessage("retry", 1),
			assistantMessage([{ type: "toolCall", id: "call-reused", name: "search", arguments: { q: 2 } }], "toolUse", 3),
			toolResult("call-reused", "good output", 4),
			userMessage("thanks", 5),
		]);
	});

	it("leaves stop, length, and toolUse turns and their results intact", () => {
		const messages: Message[] = [
			userMessage("go", 1),
			assistantMessage([{ type: "text", text: "done" }], "stop", 2),
			assistantMessage([{ type: "text", text: "cut off" }], "length", 3),
			assistantMessage([{ type: "toolCall", id: "call-kept", name: "search", arguments: {} }], "toolUse", 4),
			toolResult("call-kept", "kept output", 5),
		];

		const result = dropFailedAssistantTurns(messages);

		expect(result).toEqual(messages);
	});
});
