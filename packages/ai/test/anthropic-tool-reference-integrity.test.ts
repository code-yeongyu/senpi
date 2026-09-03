import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Context, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";

/**
 * Anthropic rejects a request whose message history references a tool that is
 * neither defined in `tools` nor discovered through a `tool_reference` block:
 *
 *   400 invalid_request_error: Tool reference 'mcp_computer_use_drag' not
 *   found in available tools
 *
 * Sessions outlive their tools — an MCP server can be absent after a resume,
 * an extension can stop registering a tool, or a payload hook can strip a
 * definition while history still carries the call. The provider must demote
 * those references to plain text (in lockstep with their tool_results) so the
 * turn can proceed instead of failing the whole request.
 */

interface CapturedRequest {
	params: Record<string, unknown>;
}

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function finalTextResponse(): Response {
	return createSseResponse([
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	]);
}

function createFakeAnthropicClient(captured: CapturedRequest): Anthropic {
	return {
		beta: {
			messages: {
				create: (params: unknown) => {
					captured.params = params as Record<string, unknown>;
					return { asResponse: async () => finalTextResponse() };
				},
			},
		},
	} as Anthropic;
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function toolResultMessage(
	toolCallId: string,
	toolName: string,
	text: string,
	addedToolNames?: string[],
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...(addedToolNames ? { addedToolNames } : {}),
	};
}

function makeTool(name: string): Tool {
	return {
		name,
		description: `Test tool ${name}`,
		parameters: Type.Object({ input: Type.Optional(Type.String()) }),
	};
}

async function captureParams(
	context: Context,
	onPayload?: (payload: unknown) => unknown,
	modelId: "claude-haiku-4-5" | "claude-sonnet-4-6" = "claude-haiku-4-5",
): Promise<Record<string, unknown>> {
	const captured: CapturedRequest = { params: {} };
	const model = getModel("anthropic", modelId);
	const s = streamAnthropic(model, context, {
		apiKey: "fake-key",
		client: createFakeAnthropicClient(captured),
		...(onPayload ? { onPayload: (payload) => onPayload(payload) as never } : {}),
	});
	await s.result();
	return captured.params;
}

interface Block {
	type: string;
	id?: string;
	name?: string;
	tool_use_id?: string;
	text?: string;
	content?: unknown;
}

function messagesOf(params: Record<string, unknown>): Array<{ role: string; content: unknown }> {
	return params.messages as Array<{ role: string; content: unknown }>;
}

function blocksOf(message: { content: unknown }): Block[] {
	return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

function allBlocks(params: Record<string, unknown>): Block[] {
	return messagesOf(params).flatMap((message) => blocksOf(message));
}

function toolUseBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "tool_use");
}

function toolResultBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "tool_result");
}

function textBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "text");
}

function toolNamesIn(params: Record<string, unknown>): string[] {
	const tools = (params.tools ?? []) as Array<{ name: string }>;
	return tools.map((tool) => tool.name);
}

describe("Anthropic tool-reference integrity", () => {
	it("demotes history tool calls whose tool is no longer available", async () => {
		const context: Context = {
			messages: [
				userMessage("drag the window"),
				fauxAssistantMessage(fauxToolCall("mcp_computer_use_drag", { x: 10, y: 20 }, { id: "call_gone" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_gone", "mcp_computer_use_drag", "dragged to 10,20"),
				userMessage("thanks"),
			],
			tools: [],
		};

		const params = await captureParams(context);

		// No tool_use or tool_result may reference the missing tool.
		expect(toolUseBlocks(params).map((block) => block.name)).not.toContain("mcp_computer_use_drag");
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).not.toContain("call_gone");

		// The history intent survives as plain text instead of failing the request.
		const texts = textBlocks(params)
			.map((block) => block.text ?? "")
			.join("\n");
		expect(texts).toContain("mcp_computer_use_drag");
		expect(texts).toContain("dragged to 10,20");

		// No empty-content messages may be left behind.
		for (const message of messagesOf(params)) {
			if (Array.isArray(message.content)) expect(message.content.length).toBeGreaterThan(0);
		}
	});

	it("demotes only the missing tool in a mixed assistant turn", async () => {
		const context: Context = {
			messages: [
				userMessage("drag then read"),
				fauxAssistantMessage(
					[
						fauxToolCall("mcp_computer_use_drag", { x: 1, y: 2 }, { id: "call_gone" }),
						fauxToolCall("read", { input: "f" }, { id: "call_kept" }),
					],
					{ stopReason: "toolUse" },
				),
				toolResultMessage("call_gone", "mcp_computer_use_drag", "dragged"),
				toolResultMessage("call_kept", "read", "file contents"),
				userMessage("go on"),
			],
			tools: [makeTool("read")],
		};

		const params = await captureParams(context);

		expect(toolUseBlocks(params).map((block) => block.name)).toEqual(["read"]);
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toEqual(["call_kept"]);
		expect(toolNamesIn(params)).toEqual(["read"]);
	});

	it("keeps tool calls for tools that are still available", async () => {
		const context: Context = {
			messages: [
				userMessage("drag the window"),
				fauxAssistantMessage(fauxToolCall("mcp_computer_use_drag", { x: 10, y: 20 }, { id: "call_kept" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_kept", "mcp_computer_use_drag", "dragged"),
				userMessage("thanks"),
			],
			tools: [makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(context);

		expect(toolUseBlocks(params).map((block) => block.name)).toContain("mcp_computer_use_drag");
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toContain("call_kept");
	});

	it("keeps deferred tools discovered through tool_reference blocks", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "drag" }, { id: "call_search" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_search", "tool_search", "1 tool(s) activated", ["mcp_computer_use_drag"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		// The unused activated tool ships deferred, and its tool_reference must survive.
		const tools = (params.tools ?? []) as Array<{ name: string; defer_loading?: boolean }>;
		expect(tools.some((tool) => tool.name === "mcp_computer_use_drag" && tool.defer_loading === true)).toBe(true);
		const references = toolResultBlocks(params).flatMap((block) =>
			Array.isArray(block.content) ? (block.content as Array<{ type: string; tool_name?: string }>) : [],
		);
		expect(references.some((ref) => ref.type === "tool_reference" && ref.tool_name === "mcp_computer_use_drag")).toBe(
			true,
		);
	});

	it("strips tool_reference blocks whose definition was removed by a payload hook", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "drag" }, { id: "call_search" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_search", "tool_search", "1 tool(s) activated", ["mcp_computer_use_drag"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(
			context,
			(payload) => {
				const mutable = payload as { tools?: Array<{ name: string }> };
				mutable.tools = (mutable.tools ?? []).filter((tool) => tool.name !== "mcp_computer_use_drag");
				return payload;
			},
			"claude-sonnet-4-6",
		);

		expect(toolNamesIn(params)).not.toContain("mcp_computer_use_drag");
		const references = toolResultBlocks(params).flatMap((block) =>
			Array.isArray(block.content) ? (block.content as Array<{ type: string; tool_name?: string }>) : [],
		);
		expect(references.some((ref) => ref.type === "tool_reference" && ref.tool_name === "mcp_computer_use_drag")).toBe(
			false,
		);
		// The reference-carrying tool_result must not end up with empty content.
		for (const block of toolResultBlocks(params)) {
			if (Array.isArray(block.content)) expect(block.content.length).toBeGreaterThan(0);
		}
	});
});
