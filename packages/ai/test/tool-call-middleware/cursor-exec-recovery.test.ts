import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { wrapStreamWithModelRecovery } from "../../src/tool-call-middleware/index.ts";
import type { AssistantMessage, Model, Tool, ToolCall } from "../../src/types.ts";
import {
	type CursorExecResolvedCarrier,
	isCursorExecResolved,
	kCursorExecResolved,
} from "../../src/utils/block-symbols.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";

const bashTool = {
	name: "bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String() }),
} satisfies Tool;

function model(id: string): Model<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-agent",
		provider: "cursor",
		model: "mock-cursor",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function resolvedToolCall(): ToolCall {
	const block: ToolCall & CursorExecResolvedCarrier = {
		type: "toolCall",
		id: "cursor-call-1",
		name: "bash",
		arguments: { command: "echo hi" },
	};
	block[kCursorExecResolved] = true;
	return block;
}

describe("cursor exec metadata through model recovery", () => {
	it.each(["kimi-k3", "claude-opus-4-8"])("preserves the resolved marker for %s", async (modelId) => {
		const inner = createAssistantMessageEventStream();
		const wrapped = wrapStreamWithModelRecovery(inner, model(modelId), [bashTool]);
		const toolCall = resolvedToolCall();
		const message = assistant([toolCall]);

		inner.push({ type: "start", partial: assistant([]) });
		inner.push({ type: "toolcall_start", contentIndex: 0, partial: message });
		inner.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
		inner.push({ type: "done", reason: "stop", message });
		inner.end();

		const result = await wrapped.result();
		const finalBlock = result.content[0];
		expect(finalBlock?.type).toBe("toolCall");
		expect(isCursorExecResolved(finalBlock)).toBe(true);
	});
});
