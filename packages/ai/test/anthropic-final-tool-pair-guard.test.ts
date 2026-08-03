import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Context, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";

const FIRST_TOOL_USE_ID = "toolu_first";
const SECOND_TOOL_USE_ID = "toolu_second";

type WireBlock = {
	type: string;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
};

type WireMessage = {
	role: string;
	content: WireBlock[];
};

type WirePayload = {
	messages: WireMessage[];
};

function createSseResponse(): Response {
	const events = [
		[
			"message_start",
			{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
		["message_stop", { type: "message_stop" }],
	] as const;
	return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function toolResultMessage(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: `${toolName} result` }],
		isError: false,
		timestamp: Date.now(),
	};
}

function makeTool(name: string): Tool {
	return { name, description: name, parameters: Type.Object({}) };
}

function immediateResultMessage(payload: WirePayload): WireMessage {
	const assistantIndex = payload.messages.findIndex(
		(message) => message.role === "assistant" && message.content.some((block) => block.type === "tool_use"),
	);
	const message = payload.messages[assistantIndex + 1];
	if (message?.role !== "user") throw new Error("tool result message missing");
	return message;
}

describe("Anthropic final tool-pair guard", () => {
	it("repairs a result removed by the last payload hook before SDK submission", async () => {
		let captured: WirePayload | undefined;
		const client = {
			messages: {
				create: (params: unknown) => {
					captured = params as WirePayload;
					return { asResponse: async () => createSseResponse() };
				},
			},
		} as Anthropic;
		const context: Context = {
			messages: [
				userMessage("run both tools"),
				fauxAssistantMessage(
					[
						fauxToolCall("read", {}, { id: FIRST_TOOL_USE_ID }),
						fauxToolCall("bash", {}, { id: SECOND_TOOL_USE_ID }),
					],
					{ stopReason: "toolUse" },
				),
				toolResultMessage(FIRST_TOOL_USE_ID, "read"),
				toolResultMessage(SECOND_TOOL_USE_ID, "bash"),
				userMessage("continue"),
			],
			tools: [makeTool("read"), makeTool("bash")],
		};

		const stream = streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, {
			apiKey: "fake-key",
			client,
			onPayload: (payload) => {
				const rewritten = structuredClone(payload) as WirePayload;
				const resultMessage = immediateResultMessage(rewritten);
				resultMessage.content = resultMessage.content.filter((block) => block.tool_use_id !== SECOND_TOOL_USE_ID);
				return rewritten;
			},
		});
		await stream.result();

		if (!captured) throw new Error("Anthropic request was not captured");
		const results = immediateResultMessage(captured).content.filter((block) => block.type === "tool_result");
		expect(results.map((block) => block.tool_use_id)).toEqual([FIRST_TOOL_USE_ID, SECOND_TOOL_USE_ID]);
		expect(results[1]).toMatchObject({
			tool_use_id: SECOND_TOOL_USE_ID,
			is_error: true,
		});
	});
});
