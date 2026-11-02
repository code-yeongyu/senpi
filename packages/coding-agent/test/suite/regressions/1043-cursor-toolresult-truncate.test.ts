// Cursor admission bounds a request two ways: every tool result is capped on
// its own, and the aggregate model input is held under an explicit budget by
// blanking the oldest tool result bodies. Since senpi#1603 the budget comes
// from the model window and admission never removes a message, so each case
// below states the budget it exercises.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, measureCursorModelInputSerializedBytes } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_TOOL_RESULT_MAX_CHARS, truncateToolResultBodies } from "../../../src/core/agent-session.ts";
import { admitCursorHistory } from "../../../src/core/cursor-history-admission.ts";
import { convertToLlm, convertToLlmForTransport } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

// Observed Cursor context ceilings persist; keep them out of the real agent dir.
process.env.CURSOR_CONTEXT_LIMIT_STORE = join(mkdtempSync(join(tmpdir(), "cursor-limits-")), "limits.json");

/** Explicit aggregate budget these cases exercise, in serialized model-input bytes. */
const BUDGET_BYTES = 50_000;

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

/** Serialized bytes of what Cursor replays to the model, as admission measures it. */
function modelInputBytes(messages: AgentMessage[], convert = convertToLlm): number {
	const converted = convert(messages);
	const activeUserMessageIndex = converted.at(-1)?.role === "user" ? converted.length - 1 : -1;
	return measureCursorModelInputSerializedBytes(converted, activeUserMessageIndex);
}

function textBytes(messages: AgentMessage[]): number {
	return new TextEncoder().encode(
		messages
			.flatMap((message) =>
				message.role === "toolResult"
					? message.content.filter((part) => part.type === "text").map((part) => part.text)
					: [],
			)
			.join(""),
	).byteLength;
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

	it("bounds the aggregate payload across all tool results without dropping one", () => {
		const messages = Array.from({ length: 100 }, (_, index) =>
			textMessage("toolResult", `${index}:${"가".repeat(2000)}`),
		);
		const admission = admitCursorHistory({ messages, budgetBytes: BUDGET_BYTES });
		expect(admission.changed).toBe(true);
		const next = admission.messages;
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(admission.blankedToolResults).toBeGreaterThan(0);
		expect(messageText(next[99])).toMatch(/^99:가+\n\.\.\.\[truncated\]$/);
		expect(messageText(next[0])).toBe("");
		expect(textBytes(next)).toBeLessThanOrEqual(BUDGET_BYTES);
		expect(admission.bytesAfter).toBeLessThanOrEqual(BUDGET_BYTES);
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
		const { messages: next } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS, BUDGET_BYTES);
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(textBytes(next)).toBeLessThanOrEqual(BUDGET_BYTES);
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

	it("bounds the decoded Cursor model input for CJK results", () => {
		const messages = cursorPairedMessages(Array.from({ length: 8 }, () => "界".repeat(2000)));
		const rawBytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
		expect(rawBytes).toBeGreaterThan(48_000);
		const { messages: next } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS, BUDGET_BYTES);
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(modelInputBytes(next)).toBeLessThanOrEqual(BUDGET_BYTES);
	});

	it("truncates newline-heavy parts before their serialized Cursor payload exceeds the budget", () => {
		// 16,000 raw newline characters serialize to twice that once escaped, so the
		// budget has to be compared against the serialized form, not the text length.
		const messages = cursorPairedMessages(Array.from({ length: 8 }, () => "\n".repeat(2000)));
		const budgetBytes = 20_000;
		const admission = admitCursorHistory({ messages, budgetBytes });
		expect(admission.bytesBefore).toBeGreaterThan(budgetBytes);
		expect(admission.changed).toBe(true);
		const next = admission.messages;
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(modelInputBytes(next)).toBeLessThanOrEqual(budgetBytes);
	});

	it("truncates NUL-heavy parts before their serialized Cursor payload exceeds the budget", () => {
		const messages = cursorPairedMessages(Array.from({ length: 8 }, () => "\0".repeat(2000)));
		const { messages: next, changed } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			BUDGET_BYTES,
		);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(modelInputBytes(next)).toBeLessThanOrEqual(BUDGET_BYTES);
	});

	it("bounds 1,450 emptied image parts including their envelopes", () => {
		const messages = cursorPairedMessages([""]);
		const result = messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		result.content = (imageToolResult(1450) as Extract<AgentMessage, { role: "toolResult" }>).content;
		const budgetBytes = 20_000;
		expect(modelInputBytes(messages)).toBeGreaterThan(budgetBytes);

		const admission = admitCursorHistory({ messages, budgetBytes });
		expect(admission.changed).toBe(true);
		const next = admission.messages;
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(modelInputBytes(next)).toBeLessThanOrEqual(budgetBytes);
	});

	it("accounts for adversarial tool names in Cursor model input", () => {
		const messages = cursorPairedMessages(["ok"]);
		const result = messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected tool result");
		result.toolName = "n".repeat(15_000);
		const call = messages.find((message) => message.role === "assistant");
		if (call?.role !== "assistant") throw new Error("expected assistant message");
		const toolCall = call.content.find((part) => part.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected tool call");
		toolCall.name = result.toolName;
		const budgetBytes = 20_000;
		expect(modelInputBytes(messages)).toBeGreaterThan(budgetBytes);
		const admission = admitCursorHistory({ messages, budgetBytes });
		expect(admission.changed).toBe(true);
		const next = admission.messages;
		if (!next) throw new Error("expected messages");
		// A tool name is not a body: it cannot be blanked, so the request stays
		// over budget and goes out anyway for the overflow path to handle.
		expect(next.length).toBe(messages.length);
		expect(admission.blankedToolResults).toBeGreaterThan(0);
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
		const { messages: next, changed } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS, 20_000);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
	});

	it("measures converted custom messages in Cursor admission", () => {
		const messages = [
			{ role: "custom", customType: "note", content: "x".repeat(60_000), timestamp: 0 },
			...cursorPairedMessages(["ok"]),
		] as AgentMessage[];
		const admission = admitCursorHistory({ messages, budgetBytes: BUDGET_BYTES });
		expect(admission.bytesBefore).toBeGreaterThan(BUDGET_BYTES);
		expect(admission.changed).toBe(true);
		const next = admission.messages;
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
	});

	it("keeps 200-turn Cursor admission bounded and complete", () => {
		const messages = cursorPairedMessages(Array.from({ length: 200 }, () => "x".repeat(2000)));
		const started = performance.now();
		const admission = admitCursorHistory({ messages, budgetBytes: BUDGET_BYTES });
		expect(performance.now() - started).toBeLessThan(1000);
		// 200 turns of envelopes alone exceed this budget. Every body is blanked and
		// the over-budget request still goes out whole - no turn is deleted (#1603).
		expect(admission.messages?.length).toBe(messages.length);
		expect(admission.blankedToolResults).toBe(200);
		expect(admission.bytesAfter).toBeLessThan(admission.bytesBefore);
		expect(admission.overBudget).toBe(true);
	});

	it("accounts for adversarial tool-call arguments in Cursor model input", () => {
		const messages = cursorPairedMessages(["ok"]);
		const call = messages.find((message) => message.role === "assistant");
		if (call?.role !== "assistant") throw new Error("expected assistant message");
		const toolCall = call.content.find((part) => part.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected tool call");
		toolCall.arguments = { value: "a".repeat(25_000) };
		const budgetBytes = 20_000;
		expect(modelInputBytes(messages)).toBeGreaterThan(budgetBytes);
		const admission = admitCursorHistory({ messages, budgetBytes });
		expect(admission.changed).toBe(true);
		const next = admission.messages;
		if (!next) throw new Error("expected messages");
		// Tool-call arguments are history, not a body: the turn survives intact.
		expect(next.length).toBe(messages.length);
		expect(next.filter((message) => message.role === "user").length).toBe(
			messages.filter((message) => message.role === "user").length,
		);
	});

	it("does not touch fitting 68 paired tool turns", () => {
		const messages = cursorPairedMessages(Array.from({ length: 68 }, () => "1234567890"));
		const { messages: next, changed } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			BUDGET_BYTES,
		);
		expect(changed).toBe(false);
		expect(next).toBe(messages);
	});

	it("does not touch fitting 97 paired tool turns", () => {
		const messages = cursorPairedMessages(Array.from({ length: 97 }, () => "1234567890"));
		expect(modelInputBytes(messages)).toBeLessThanOrEqual(BUDGET_BYTES);
		const { messages: next, changed } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			BUDGET_BYTES,
		);
		expect(changed).toBe(false);
		expect(next).toBe(messages);
	});

	it("blanks bodies rather than turns when 98 paired tool turns exceed the budget", () => {
		const messages = cursorPairedMessages(Array.from({ length: 98 }, () => "1234567890"));
		const budgetBytes = Math.floor(modelInputBytes(messages) / 2);

		const admission = admitCursorHistory({ messages, budgetBytes });
		expect(admission.changed).toBe(true);
		const next = admission.messages;
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(admission.blankedToolResults).toBeGreaterThan(0);
		expect(admission.bytesAfter).toBeLessThan(admission.bytesBefore);
		// Bodies are all this pass may empty; the remaining envelopes keep the
		// request over budget, and it is admitted rather than trimmed.
		expect(admission.overBudget).toBe(true);
	});

	for (const partCount of [7424, 7500]) {
		it(`keeps the ${partCount}-part Cursor model input within the budget`, () => {
			const messages = cursorPairedMessages(["placeholder"]);
			const result = messages.find((message) => message.role === "toolResult");
			if (result?.role !== "toolResult") throw new Error("expected tool result");
			result.content = Array.from({ length: partCount }, () => ({ type: "text" as const, text: "abcdefghij" }));

			const { messages: next } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS, BUDGET_BYTES);
			if (!next) throw new Error("expected messages");
			expect(next.length).toBe(messages.length);
			const transformed = next.find((message) => message.role === "toolResult");
			if (transformed?.role !== "toolResult") throw new Error("expected transformed tool result");
			expect(transformed.toolCallId).toBe(result.toolCallId);
			expect(modelInputBytes(next)).toBeLessThanOrEqual(BUDGET_BYTES);
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
			const { messages: next } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS, BUDGET_BYTES);
			if (!next) throw new Error("expected messages");
			expect(textBytes(next)).toBeLessThanOrEqual(BUDGET_BYTES);
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
		const budgetBytes = 15_000;
		expect(modelInputBytes(messages, convert)).toBeGreaterThan(budgetBytes);
		const { messages: next, changed } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			budgetBytes,
			convert,
		);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(modelInputBytes(next, convert)).toBeLessThanOrEqual(budgetBytes);
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
		expect(modelInputBytes(messages, convert)).toBeGreaterThan(BUDGET_BYTES);
		const { messages: next, changed } = truncateToolResultBodies(
			messages,
			CURSOR_TOOL_RESULT_MAX_CHARS,
			BUDGET_BYTES,
			convert,
		);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(next.length).toBe(messages.length);
		expect(modelInputBytes(next, convert)).toBeLessThanOrEqual(BUDGET_BYTES);
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
