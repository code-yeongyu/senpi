/*
 * toolcall_end consumer audit (mechanical classification):
 * AUDIT: packages/coding-agent/src/modes/app-server/threads/projection.ts — RENDERS
 *
 * The projector creates history items from toolcall_end and completes their failed
 * state from tool_execution_end. It does not invoke or dispatch a tool.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-incomplete-toolcall-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function assistantWithToolCall(incomplete: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "tool-1",
				name: "bash",
				arguments: { command: "printf ok" },
				...(incomplete ? { incomplete: true as const, errorMessage: "truncated" } : {}),
			},
		],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function reloadedToolCall(session: SessionManager) {
	const entry = session.getEntries().find((candidate) => {
		return candidate.type === "message" && candidate.message.role === "assistant";
	});
	if (entry?.type !== "message" || entry.message.role !== "assistant") {
		throw new Error("Expected a persisted assistant message");
	}
	const toolCall = entry.message.content.find((block) => block.type === "toolCall");
	if (!toolCall) {
		throw new Error("Expected a persisted tool call");
	}
	return toolCall;
}

function expectSystemTempDir(directory: string): void {
	const pathFromTemp = relative(tmpdir(), directory);
	expect(pathFromTemp).not.toBe("");
	expect(pathFromTemp.startsWith("..")).toBe(false);
	expect(isAbsolute(pathFromTemp)).toBe(false);
}

describe("incomplete tool-call session round-trip", () => {
	it("round-trips incomplete tool-call flags through the SessionManager JSONL write path", () => {
		expectSystemTempDir(tempDir);
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantWithToolCall(true));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text: "not executed" }],
			isError: true,
			timestamp: 2,
		});

		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected a persisted session file");
		}
		const reloaded = SessionManager.open(sessionFile, tempDir);
		const toolCall = reloadedToolCall(reloaded);

		expect(toolCall.incomplete).toBe(true);
		expect(toolCall.errorMessage).toBe("truncated");
	});

	it("loads legacy tool calls without incomplete flags", () => {
		expectSystemTempDir(tempDir);
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantWithToolCall(false));

		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected a persisted session file");
		}
		const reloaded = SessionManager.open(sessionFile, tempDir);
		const toolCall = reloadedToolCall(reloaded);

		expect(toolCall).toMatchObject({
			id: "tool-1",
			name: "bash",
			arguments: { command: "printf ok" },
		});
		expect(toolCall.incomplete).toBeUndefined();
		expect(toolCall.errorMessage).toBeUndefined();
	});
});
