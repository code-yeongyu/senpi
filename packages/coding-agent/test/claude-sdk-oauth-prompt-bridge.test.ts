import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildPromptBlocks, buildPromptStream } from "../src/core/extensions/builtin/claude-sdk-oauth/prompt-bridge.ts";
import { convertToLlm } from "../src/core/messages.ts";

const anchor =
	'The above is the conversation history so far, provided as context. Respond as the assistant to the user message below only. Never emit "USER:" or "ASSISTANT:" labels or continue the transcript.';

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Claude SDK OAuth prompt bridge", () => {
	it("envelopes mixed history and leaves the final user message unlabeled and last", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Find it", timestamp: 1 },
				assistantMessage(
					[{ type: "toolCall", id: "call-1", name: "repoSearch", arguments: { query: "needle" } }],
					2,
				),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "repoSearch",
					content: [{ type: "text", text: "match" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "Explain the match", timestamp: 4 },
			],
		};

		expect(buildPromptBlocks(context, new Map([["repoSearch", "mcp__custom-tools__repoSearch"]]))).toEqual([
			{ type: "text", text: "<conversation_history>\n" },
			{ type: "text", text: "USER:\n" },
			{ type: "text", text: "Find it" },
			{ type: "text", text: "\n\nASSISTANT:\n" },
			{
				type: "text",
				text: 'Historical tool call (non-executable): mcp__custom-tools__repoSearch args={"query":"needle"}',
			},
			{ type: "text", text: "\n\nTOOL RESULT (historical mcp__custom-tools__repoSearch, id=call-1):\n" },
			{ type: "text", text: "match" },
			{ type: "text", text: "\n</conversation_history>" },
			{ type: "text", text: anchor },
			{ type: "text", text: "Explain the match" },
		]);
	});

	it("emits no history envelope when the final user message is the only message", () => {
		const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };

		expect(buildPromptBlocks(context)).toEqual([
			{ type: "text", text: anchor },
			{ type: "text", text: "Hello" },
		]);
	});

	it("preserves an image-only final user message and its placeholder", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
					timestamp: 1,
				},
			],
		};

		expect(buildPromptBlocks(context)).toEqual([
			{ type: "text", text: anchor },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
			{ type: "text", text: "(see attached image)" },
		]);
	});

	it("wraps a non-empty recovered tool note outside history and before the anchor", () => {
		const context: Context = { messages: [{ role: "user", content: "Continue", timestamp: 1 }] };

		expect(buildPromptBlocks(context, undefined, "  recovered result  ")).toEqual([
			{ type: "text", text: "<recovered_tool_results>\n" },
			{ type: "text", text: "recovered result" },
			{ type: "text", text: "\n</recovered_tool_results>" },
			{ type: "text", text: anchor },
			{ type: "text", text: "Continue" },
		]);
	});

	it("wraps all messages as history when there is no final user message", () => {
		const context: Context = { messages: [assistantMessage([{ type: "text", text: "Earlier answer" }], 1)] };

		expect(buildPromptBlocks(context)).toEqual([
			{ type: "text", text: "<conversation_history>\n" },
			{ type: "text", text: "ASSISTANT:\n" },
			{ type: "text", text: "Earlier answer" },
			{ type: "text", text: "\n</conversation_history>" },
			{ type: "text", text: anchor },
		]);
	});

	it("renders no failed-turn content when the history comes from convertToLlm", () => {
		// Given a provider turn that failed mid-stream (stopReason "error"),
		// its orphaned tool result, and a healthy final user message
		const failedTurn: AssistantMessage = {
			...assistantMessage(
				[
					{ type: "text", text: "PARTIAL" },
					{ type: "toolCall", id: "call-failed", name: "repoSearch", arguments: { query: "needle" } },
				],
				2,
			),
			stopReason: "error",
		};
		const context: Context = {
			messages: convertToLlm([
				{ role: "user", content: "Find it", timestamp: 1 },
				failedTurn,
				{
					role: "toolResult",
					toolCallId: "call-failed",
					toolName: "repoSearch",
					content: [{ type: "text", text: "partial match" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "Go on", timestamp: 4 },
			]),
		};

		const rendered = buildPromptBlocks(context)
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n");

		expect(rendered).not.toContain("PARTIAL");
		expect(rendered).not.toContain("call-failed");
		expect(rendered).toContain("Find it");
		expect(rendered).toContain("Go on");
	});

	it("streams the supplied blocks as one SDK user message", async () => {
		const blocks = buildPromptBlocks({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });

		expect(await collect(buildPromptStream(blocks))).toEqual([
			{
				type: "user",
				parent_tool_use_id: null,
				session_id: "prompt",
				message: { role: "user", content: blocks },
			},
		]);
	});
});
