import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { buildCursorHistoryWireBytesForTest } from "@earendil-works/pi-ai/api/cursor-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	CURSOR_TOOL_RESULT_MAX_BYTES,
	CURSOR_TOOL_RESULT_MAX_CHARS,
	truncateToolResultBodies,
} from "../../../src/core/agent-session.ts";
import { convertToLlmForTransport } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

function textMessage(role: AgentMessage["role"], text: string): AgentMessage {
	return { role, content: [{ type: "text", text }] } as AgentMessage;
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) throw new Error("expected content message");
	const part = content[0] as { type?: string; text?: string } | undefined;
	if (part?.type !== "text" || typeof part.text !== "string") throw new Error("expected text part");
	return part.text;
}

function toolResult(text: string, id: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

function imageToolResult(partCount: number, id = "image-heavy"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: Array.from({ length: partCount }, () => ({
			type: "image" as const,
			data: "AA==",
			mimeType: "image/png",
		})),
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

function cursorPairedMessages(resultTexts: string[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const [index, text] of resultTexts.entries()) {
		const id = `call-${index}`;
		messages.push({ role: "user", content: `request ${index}`, timestamp: 0 } as AgentMessage);
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: "a.ts" } }],
			api: "cursor-agent",
			provider: "cursor",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		} as AgentMessage);
		messages.push(toolResult(text, id));
	}
	messages.push({ role: "user", content: "continue", timestamp: 0 } as AgentMessage);
	return messages;
}

function serializedCursorHistoryBytes(messages: AgentMessage[]): number {
	return buildCursorHistoryWireBytesForTest(messages as never).reduce((total, bytes) => total + bytes.byteLength, 0);
}

describe("1043 cursor toolResult truncate", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	it("caps long toolResult text at a code-point-safe, marker-inclusive boundary", () => {
		const messages = [
			textMessage("user", "진행해"),
			textMessage("assistant", "ok".repeat(5000)),
			textMessage("toolResult", `${"a".repeat(1998)}😀tail`),
		];
		const original = messages[2];
		const { messages: next, changed } = truncateToolResultBodies(messages, 2000);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(messageText(next[1]).length).toBe(10_000);
		expect(next[2]).not.toBe(original);
		expect(messageText(messages[2])).toBe(`${"a".repeat(1998)}😀tail`);
		const toolText = messageText(next[2]);
		expect(toolText).toMatch(/^a+\n\.\.\.\[truncated\]$/);
		expect(toolText.length).toBeLessThanOrEqual(2000);
		expect([...toolText].length).toBeLessThanOrEqual(2000);
		expect(toolText).not.toContain("\ud800");
	});

	it("bounds the aggregate UTF-8 payload across all tool results", () => {
		const messages = Array.from({ length: 100 }, (_, index) =>
			textMessage("toolResult", `${index}:${"가".repeat(2000)}`),
		);
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(messageText(next[99])).toMatch(/^99:가+\n\.\.\.\[truncated\]$/);
		expect(messageText(next[0])).toBe("");
		const bytes = new TextEncoder().encode(next.map(messageText).join("")).byteLength;
		expect(bytes).toBeLessThanOrEqual(50_000);
	});

	it("reserves marker budget before the full-part fast path (review reproduction)", () => {
		const messages = [
			toolResult("x".repeat(100), "old"),
			toolResult("가".repeat(2000), "cjk-0"),
			toolResult("가".repeat(2000), "cjk-1"),
			toolResult("가".repeat(2000), "cjk-2"),
			toolResult("가".repeat(2000), "cjk-3"),
			toolResult("가".repeat(2000), "cjk-4"),
			toolResult("가".repeat(2000), "cjk-5"),
			toolResult("가".repeat(2000), "cjk-6"),
			toolResult("가".repeat(2000), "cjk-7"),
			toolResult("n".repeat(1990), "newest"),
		];
		const { messages: next } = truncateToolResultBodies(messages);
		if (!next) throw new Error("expected messages");
		const bytes = new TextEncoder().encode(
			next
				.flatMap((message) =>
					message.role === "toolResult"
						? message.content.filter((part) => part.type === "text").map((part) => part.text)
						: [],
				)
				.join(""),
		).byteLength;
		expect(bytes).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("truncates Cursor admission while persisting the full tool result through AgentSession", async () => {
		let admittedText = "";
		const largeTool: AgentTool = {
			name: "large-result",
			label: "Large result",
			description: "Returns a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "payload ".repeat(20_000) }], details: {} }),
		};
		const harness = await createHarness({
			provider: "cursor",
			models: [{ id: "cursor", contextWindow: 100_000 }],
			tools: [largeTool],
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large-result", {}), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				admittedText =
					result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "";
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("run the large tool");

		expect(admittedText).not.toContain("payload ".repeat(20_000));
		const persisted = harness.sessionManager
			.getEntries()
			.filter((entry): entry is typeof entry & { message: AgentMessage } => "message" in entry)
			.map((entry) => entry.message)
			.find((message) => message.role === "toolResult");
		expect(
			persisted?.role === "toolResult" && persisted.content[0]?.type === "text" ? persisted.content[0].text : "",
		).toBe("payload ".repeat(20_000));
	});

	it("bounds the duplicated decoded Cursor root and turn history for CJK results", () => {
		const messages = cursorPairedMessages(Array.from({ length: 8 }, () => "界".repeat(2000)));
		const rawBytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
		expect(rawBytes).toBeGreaterThan(48_000);
		const { messages: next } = truncateToolResultBodies(messages);
		if (!next) throw new Error("expected messages");
		expect(serializedCursorHistoryBytes(next)).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("truncates newline-heavy parts before their serialized Cursor payload exceeds the cap", () => {
		const messages = cursorPairedMessages(Array.from({ length: 8 }, () => "\n".repeat(2000)));
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(serializedCursorHistoryBytes(next)).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("truncates NUL-heavy parts before their serialized Cursor payload exceeds the cap", () => {
		const messages = cursorPairedMessages(Array.from({ length: 8 }, () => "\0".repeat(2000)));
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(serializedCursorHistoryBytes(next)).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("bounds 1,450 emptied image parts including their envelopes", () => {
		const messages = cursorPairedMessages([""]);
		const result = messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		result.content = (imageToolResult(1450) as Extract<AgentMessage, { role: "toolResult" }>).content;
		const before = serializedCursorHistoryBytes(messages);
		expect(before).toBeGreaterThan(CURSOR_TOOL_RESULT_MAX_BYTES);

		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(
			buildCursorHistoryWireBytesForTest(next as never).reduce((total, bytes) => total + bytes.byteLength, 0),
		).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("accounts for adversarial tool names in Cursor wire history", () => {
		const messages = cursorPairedMessages(["ok"]);
		const result = messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		result.toolName = "n".repeat(15_000);
		const call = messages.find((message) => message.role === "assistant");
		if (call?.role !== "assistant") throw new Error("expected assistant message");
		const toolCall = call.content.find((part) => part.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected tool call");
		toolCall.name = result.toolName;
		const before = serializedCursorHistoryBytes(messages);
		expect(before).toBeGreaterThan(CURSOR_TOOL_RESULT_MAX_BYTES);
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(
			buildCursorHistoryWireBytesForTest(next as never).reduce((total, bytes) => total + bytes.byteLength, 0),
		).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("uses the full history when admission ends in a resumed tool result", () => {
		const messages = cursorPairedMessages(["ok"]);
		messages.pop();
		const call = messages.find((message) => message.role === "assistant");
		if (call?.role !== "assistant") throw new Error("expected assistant message");
		const toolCall = call.content.find((part) => part.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected tool call");
		toolCall.name = "n".repeat(15_000);
		const result = messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		result.toolName = toolCall.name;
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		expect(next).toBeDefined();
	});

	it("measures converted custom messages in Cursor admission", () => {
		const messages = [
			{ role: "custom", customType: "note", content: "x".repeat(60_000), timestamp: 0 },
			...cursorPairedMessages(["ok"]),
		] as AgentMessage[];
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		expect(next).toBeDefined();
	});

	it("keeps 200-turn Cursor admission bounded", () => {
		const messages = cursorPairedMessages(Array.from({ length: 200 }, () => "x".repeat(2000)));
		const started = performance.now();
		truncateToolResultBodies(messages);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("accounts for adversarial tool-call arguments in Cursor wire history", () => {
		const messages = cursorPairedMessages(["ok"]);
		const call = messages.find((message) => message.role === "assistant");
		if (call?.role !== "assistant") throw new Error("expected assistant message");
		const toolCall = call.content.find((part) => part.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected tool call");
		toolCall.arguments = { value: "a".repeat(25_000) };
		const before = serializedCursorHistoryBytes(messages);
		expect(before).toBeGreaterThan(CURSOR_TOOL_RESULT_MAX_BYTES);
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(
			buildCursorHistoryWireBytesForTest(next as never).reduce((total, bytes) => total + bytes.byteLength, 0),
		).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("does not evict fitting 68 paired tool turns", () => {
		const messages = cursorPairedMessages(Array.from({ length: 68 }, () => "1234567890"));
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(false);
		expect(next).toBe(messages);
	});

	it("does not evict fitting 97 paired tool turns", () => {
		const messages = cursorPairedMessages(Array.from({ length: 97 }, () => "1234567890"));
		expect(serializedCursorHistoryBytes(messages)).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(false);
		expect(next).toBe(messages);
	});

	it("bounds aggregate envelopes across 98 paired tool turns", () => {
		const messages = cursorPairedMessages(Array.from({ length: 98 }, () => "1234567890"));
		const before = serializedCursorHistoryBytes(messages);
		expect(before).toBeGreaterThan(CURSOR_TOOL_RESULT_MAX_BYTES);

		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(
			buildCursorHistoryWireBytesForTest(next as never).reduce((total, bytes) => total + bytes.byteLength, 0),
		).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	for (const partCount of [7424, 7500]) {
		it(`keeps the ${partCount}-part Cursor wire representation within the bound`, () => {
			const messages = cursorPairedMessages(["placeholder"]);
			const result = messages.find((message) => message.role === "toolResult");
			if (result?.role !== "toolResult") throw new Error("expected tool result");
			result.content = Array.from({ length: partCount }, () => ({ type: "text" as const, text: "abcdefghij" }));

			const { messages: next } = truncateToolResultBodies(messages);
			if (!next) throw new Error("expected messages");
			const transformed = next.find((message) => message.role === "toolResult");
			if (transformed?.role !== "toolResult") throw new Error("expected transformed tool result");
			expect(transformed.toolCallId).toBe(result.toolCallId);
			expect(
				buildCursorHistoryWireBytesForTest(next as never).reduce((total, bytes) => total + bytes.byteLength, 0),
			).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
			expect(
				transformed.content.filter((part) => part.type === "text" && part.text === "").length,
			).toBeLessThanOrEqual(1);
		});
	}

	for (const partCount of [3334, 5000]) {
		it(`does not amplify ${partCount} tiny parts with truncation markers`, () => {
			const messages = [
				{
					...toolResult("", `many-${partCount}`),
					content: Array.from({ length: partCount }, () => ({ type: "text" as const, text: "abcdefghij" })),
				},
			];
			const { messages: next } = truncateToolResultBodies(messages);
			if (!next) throw new Error("expected messages");
			const bytes = new TextEncoder().encode(
				next[0].role === "toolResult"
					? next[0].content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("")
					: "",
			).byteLength;
			expect(bytes).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
		});
	}

	it("measures blocked images with the configured transport converter (R9-1)", () => {
		const messages = cursorPairedMessages([""]);
		const result = messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		result.content = Array.from({ length: 708 * 2 }, (_, index) =>
			index % 2 === 0
				? { type: "image" as const, data: "AA==", mimeType: "image/png" }
				: { type: "text" as const, text: "x" },
		);
		const convert = (candidate: AgentMessage[]) =>
			convertToLlmForTransport(candidate, { blockImages: true, alwaysKeepNewest: 1 });
		const before = serializedCursorHistoryBytes(convert(messages) as never);
		expect(before).toBeGreaterThan(CURSOR_TOOL_RESULT_MAX_BYTES);
		const { messages: next, changed } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			CURSOR_TOOL_RESULT_MAX_BYTES,
			convert,
		);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(serializedCursorHistoryBytes(convert(next) as never)).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("measures maxHistoricalImages elision with the configured transport converter (R9-1)", () => {
		const messages = cursorPairedMessages([""]);
		const result = messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		result.content = Array.from({ length: 708 * 2 }, (_, index) =>
			index % 2 === 0
				? { type: "image" as const, data: "AA==", mimeType: "image/png" }
				: { type: "text" as const, text: "x" },
		);
		messages.splice(messages.length - 1, 0, textMessage("assistant", "completed"));
		const convert = (candidate: AgentMessage[]) =>
			convertToLlmForTransport(candidate, { blockImages: false, maxHistoricalImages: 0, alwaysKeepNewest: 1 });
		const before = serializedCursorHistoryBytes(convert(messages) as never);
		expect(before).toBeGreaterThan(CURSOR_TOOL_RESULT_MAX_BYTES);
		const { messages: next, changed } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			CURSOR_TOOL_RESULT_MAX_BYTES,
			convert,
		);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(serializedCursorHistoryBytes(convert(next) as never)).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("keeps grapheme clusters intact and retains a marker when only marker space remains", () => {
		const messages = [textMessage("toolResult", "👩‍💻e\u0301".repeat(10))];
		const { messages: next } = truncateToolResultBodies(messages, 4, 20);
		const text = next ? messageText(next[0]) : "";
		expect(text).toBe("");
		expect(text).not.toMatch(/👩(?:$|[^‍])/u);
		expect(text).not.toMatch(/e$/u);
	});

	it("is a no-op when every toolResult is already short", () => {
		const messages = [textMessage("toolResult", "ok")];
		const { changed } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS);
		expect(changed).toBe(false);
	});
});
