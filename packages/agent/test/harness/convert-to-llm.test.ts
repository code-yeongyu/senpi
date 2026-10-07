// Harness convertToLlm drops failed provider turns (stopReason error/aborted) and their orphaned tool results.

import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/harness/messages.ts";
import type { AgentMessage } from "../../src/types.ts";

function usage(): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function failedAssistant(stopReason: "error" | "aborted", toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "PARTIAL_BEFORE_FAILURE" },
			{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function orphanResult(toolCallId: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "Tool aborted" }],
		isError: true,
		timestamp: Date.now(),
	};
}

describe("harness convertToLlm failed-turn drop", () => {
	it("drops an errored assistant turn and its orphaned tool result", () => {
		const out = convertToLlm([user("do X"), failedAssistant("error", "c1"), orphanResult("c1"), user("next")]);
		const serialized = JSON.stringify(out);
		expect(out).toHaveLength(2);
		expect(out.every((m: Message) => m.role === "user")).toBe(true);
		expect(serialized).not.toContain("PARTIAL_BEFORE_FAILURE");
		expect(serialized).not.toContain("c1");
	});

	it("drops an aborted assistant turn and its orphaned tool result", () => {
		const out = convertToLlm([user("do X"), failedAssistant("aborted", "c2"), orphanResult("c2")]);
		const serialized = JSON.stringify(out);
		expect(out).toHaveLength(1);
		expect(serialized).not.toContain("PARTIAL_BEFORE_FAILURE");
		expect(serialized).not.toContain("c2");
	});

	it("keeps a tool result whose id a later kept assistant re-declares", () => {
		const kept: AssistantMessage = {
			...failedAssistant("error", "c3"),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "ls" } }],
		};
		const out = convertToLlm([user("do X"), failedAssistant("error", "c3"), orphanResult("c3"), kept]);
		const serialized = JSON.stringify(out);
		expect(serialized).toContain("c3");
		expect(serialized).toContain("Tool aborted");
		expect(serialized).not.toContain("PARTIAL_BEFORE_FAILURE");
	});
});
