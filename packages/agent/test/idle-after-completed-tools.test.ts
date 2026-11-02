import { type AssistantMessage, kCursorExecResolved, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isStreamIdleTimeoutError, shouldFinalizeIdleAsStop } from "../src/assistant-terminal-state.ts";

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-agent",
		provider: "cursor",
		model: "mock",
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

describe("shouldFinalizeIdleAsStop", () => {
	it("finalizes resolved Cursor tools after idle", () => {
		const tool = { type: "toolCall" as const, id: "t1", name: "task", arguments: {} };
		(tool as Record<PropertyKey, unknown>)[kCursorExecResolved] = true;
		expect(shouldFinalizeIdleAsStop(message([tool]), [])).toBe(true);
	});

	it("does not finalize text-only idle", () => {
		expect(shouldFinalizeIdleAsStop(message([{ type: "text", text: "hi" }]), [])).toBe(false);
	});

	it("finalizes when exec results are already buffered", () => {
		const tool = { type: "toolCall" as const, id: "t1", name: "bash", arguments: {} };
		const results: ToolResultMessage[] = [
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: 0 },
		];
		expect(shouldFinalizeIdleAsStop(message([tool]), results)).toBe(true);
	});

	it("recognizes the idle error name", () => {
		const error = new Error("Idle timeout waiting for provider stream after 40ms");
		error.name = "StreamIdleTimeoutError";
		expect(isStreamIdleTimeoutError(error)).toBe(true);
		expect(isStreamIdleTimeoutError(new Error("other"))).toBe(false);
	});
});
