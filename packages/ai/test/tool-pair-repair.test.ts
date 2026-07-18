import { describe, expect, it } from "vitest";
import {
	type AssistantMessage,
	type Message,
	repairOrphanedToolResults,
	type TextContent,
	TOOL_RESULT_PLACEHOLDER,
	type ToolResultMessage,
	type UserMessage,
} from "../src/index.ts";

function userMsg(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantWithCall(id: string, name: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path: "." } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(id: string, name: string, timestamp: number, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function assistantWithFlaggedCall(
	id: string,
	name: string,
	timestamp: number,
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id,
				name,
				arguments: {},
				incomplete: true,
				...(errorMessage ? { errorMessage } : {}),
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function retryText(name: string): string {
	return `Tool call "${name}" was not executed: the response ended before the tool call was complete. Re-issue the tool call with complete arguments.`;
}

function resultText(message: ToolResultMessage): string {
	return message.content.find((block): block is TextContent => block.type === "text")?.text ?? "";
}

describe("repairOrphanedToolResults", () => {
	it("returns identical structure for valid tool pairs", () => {
		const messages: Message[] = [
			userMsg("list files", 1),
			assistantWithCall("call-1", "ls", 2),
			toolResult("call-1", "ls", 3, "done"),
		];

		const result = repairOrphanedToolResults(messages);

		expect(result).toEqual(messages);
	});

	it("replaces orphan tool result content with placeholder", () => {
		const messages: Message[] = [userMsg("run", 1), toolResult("missing", "ls", 2, "real output")];

		const result = repairOrphanedToolResults(messages);

		expect(result).toHaveLength(2);
		expect(result[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "missing",
			content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }],
		});
	});

	it("inserts synthetic tool result for dangling assistant tool call", () => {
		const messages: Message[] = [userMsg("run", 1), assistantWithCall("call-2", "pwd", 2)];

		const result = repairOrphanedToolResults(messages);

		expect(result).toHaveLength(3);
		expect(result[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "pwd",
			content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }],
			isError: false,
		});
	});

	it("handles mixed orphan tool results and dangling tool calls", () => {
		const messages: Message[] = [
			userMsg("run", 1),
			assistantWithCall("call-3", "ls", 2),
			toolResult("orphan", "cat", 3, "old output"),
		];

		const result = repairOrphanedToolResults(messages);

		expect(result).toHaveLength(4);
		expect(result).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: "orphan",
				content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }],
			}),
		);
		expect(result).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: "call-3",
				toolName: "ls",
				content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }],
			}),
		);
	});

	// todo-12: error placeholders with retry diagnostics for flagged dangling calls
	it("synthesizes an isError:true retry-diagnostic result for a flagged dangling tool call (case a)", () => {
		const messages: Message[] = [userMsg("run", 1), assistantWithFlaggedCall("call-flag", "bash", 2)];

		const result = repairOrphanedToolResults(messages);

		expect(result).toHaveLength(3);
		const synth = result[2] as ToolResultMessage;
		expect(synth).toMatchObject({
			role: "toolResult",
			toolCallId: "call-flag",
			toolName: "bash",
			isError: true,
		});
		expect(resultText(synth)).toBe(retryText("bash"));
		const errorResults = result.filter((m): m is ToolResultMessage => m.role === "toolResult" && m.isError === true);
		expect(errorResults).toHaveLength(1);
	});

	it("is idempotent: a second repair pass deep-equals the first pass (case b)", () => {
		const messages: Message[] = [userMsg("run", 1), assistantWithFlaggedCall("call-flag", "bash", 2)];

		const once = repairOrphanedToolResults(messages);
		const twice = repairOrphanedToolResults(once);

		expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
	});

	it("keeps legacy non-flagged dangling calls as isError:false with the placeholder (case c)", () => {
		const messages: Message[] = [userMsg("run", 1), assistantWithCall("call-legacy", "pwd", 2)];

		const result = repairOrphanedToolResults(messages);

		expect(result).toHaveLength(3);
		expect(result[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "call-legacy",
			toolName: "pwd",
			content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }],
			isError: false,
		});
	});

	it("leaves a flagged tool call untouched when a real toolResult already exists (case d)", () => {
		const messages: Message[] = [
			userMsg("run", 1),
			assistantWithFlaggedCall("call-flag-real", "bash", 2),
			toolResult("call-flag-real", "bash", 3, "real output"),
		];

		const result = repairOrphanedToolResults(messages);

		expect(result).toEqual(messages);
		const realResult = result[2] as ToolResultMessage;
		expect(realResult.isError).toBe(false);
		expect(resultText(realResult)).toBe("real output");
	});

	it("appends the retry instruction to the tool call's errorMessage without a duplicate period", () => {
		const messages: Message[] = [
			userMsg("run", 1),
			assistantWithFlaggedCall("call-err", "bash", 2, "custom truncation reason."),
		];

		const result = repairOrphanedToolResults(messages);

		expect(result).toHaveLength(3);
		const synth = result[2] as ToolResultMessage;
		expect(synth.isError).toBe(true);
		expect(resultText(synth)).toBe("custom truncation reason. Re-issue the tool call with complete arguments.");
	});
});
