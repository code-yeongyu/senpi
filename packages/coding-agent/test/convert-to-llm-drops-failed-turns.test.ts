import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";

function failedAssistant(
	stopReason: "error" | "aborted",
	text: string,
	toolCallId: string,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: toolCallId, name: "search", arguments: { q: "needle" } },
		],
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

function userMessage(text: string, timestamp: number): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content: text, timestamp };
}

describe("convertToLlm drops failed assistant turns", () => {
	it("omits an errored assistant's partial text and orphaned tool call", () => {
		// Given a session where one provider turn failed mid-stream
		const messages = [
			userMessage("first", 1),
			failedAssistant("error", "PARTIAL", "call-1", 2),
			toolResult("call-1", "partial result", 3),
			userMessage("next", 4),
		];

		// When the history is converted for the LLM
		const result = convertToLlm(messages);

		// Then the failed turn and its orphaned tool result are gone
		expect(result).toEqual([userMessage("first", 1), userMessage("next", 4)]);
		expect(JSON.stringify(result)).not.toContain("PARTIAL");
		expect(JSON.stringify(result)).not.toContain("call-1");
	});

	it("omits an aborted assistant's partial text and orphaned tool call", () => {
		const messages = [
			userMessage("first", 1),
			failedAssistant("aborted", "STOPPED-MID", "call-2", 2),
			toolResult("call-2", "aborted result", 3),
			userMessage("next", 4),
		];

		const result = convertToLlm(messages);

		expect(result).toEqual([userMessage("first", 1), userMessage("next", 4)]);
		expect(JSON.stringify(result)).not.toContain("STOPPED-MID");
		expect(JSON.stringify(result)).not.toContain("call-2");
	});
});
