import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hardLimitEmergencyPrune } from "../../src/core/extensions/builtin/compaction/speculative.ts";

const estimateTracker = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/core/compaction/index.ts", () => ({
	DEFAULT_COMPACTION_SETTINGS: {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: 20_000,
	},
	estimateContextTokens: () => ({ tokens: 0 }),
	estimateTokens: (message: AgentMessage) => {
		estimateTracker.calls += 1;
		if (message.role === "user") return 1;
		if (message.role === "toolResult") return 1;
		if (message.role === "assistant") return 1;
		if (message.role === "bashExecution") return 1;
		if (message.role === "branchSummary") return 1;
		if (message.role === "custom") return 1;
		return 1;
	},
	prepareCompaction: () => undefined,
	serializeConversation: () => "",
}));

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantText(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux-completion",
		provider: "faux",
		model: "faux-model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp,
	};
}

function assistantToolCall(id: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { cmd: `echo ${id}` } }],
		api: "faux-completion",
		provider: "faux",
		model: "faux-model",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(id: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: `result ${id}` }],
		isError: false,
		timestamp,
	};
}

function labelMessage(message: AgentMessage): string {
	if (message.role === "user") {
		const content = message.content;
		return `user:${
			typeof content === "string"
				? content
				: content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("")
		}`;
	}
	if (message.role === "assistant") {
		const first = message.content[0];
		if (!first) return "assistant:empty";
		if (first.type === "toolCall") return `assistant-tool:${first.id}`;
		if (first.type === "text") return `assistant:${first.text}`;
		return `assistant:${first.type}`;
	}
	if (message.role === "toolResult") return `tool:${message.toolCallId}`;
	return message.role;
}

describe("hard-limit emergency prune trimming", () => {
	beforeEach(() => {
		estimateTracker.calls = 0;
	});

	it("preserves the current old-message pruning output when representative overflow must trim", () => {
		// Given
		const messages: AgentMessage[] = [
			userMessage("old setup", 1),
			assistantToolCall("call-1", 2),
			toolResult("call-1", 3),
			assistantText("old explanation", 4),
			userMessage("older follow-up", 5),
			assistantToolCall("call-2", 6),
			toolResult("call-2", 7),
			userMessage("latest request", 8),
		];

		// When
		const result = hardLimitEmergencyPrune(messages, 4);
		const labels = result.messages.map(labelMessage);

		// Then
		expect(result.needsAggressiveCompaction).toBe(true);
		if (process.env.WI3_EVIDENCE === "1") console.info(`wi3-output-equivalence labels=${JSON.stringify(labels)}`);
		expect(labels).toEqual(["assistant:old explanation", "user:older follow-up", "user:latest request"]);
	});

	it("estimates tokens linearly when many old messages must be trimmed", () => {
		// Given
		const messages = Array.from({ length: 300 }, (_, index): AgentMessage => userMessage(`old-${index}`, index));
		const maxLinearCalls = messages.length * 4;

		// When
		const result = hardLimitEmergencyPrune(messages, 32);

		// Then
		expect(result.needsAggressiveCompaction).toBe(true);
		expect(result.messages).toHaveLength(30);
		if (process.env.WI3_EVIDENCE === "1") {
			console.info(
				`wi3-call-count calls=${estimateTracker.calls} bound=${maxLinearCalls} retained=${result.messages.length}`,
			);
		}
		expect(estimateTracker.calls).toBeLessThanOrEqual(maxLinearCalls);
	});
});
