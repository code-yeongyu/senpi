import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage, Context, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";

/**
 * Shared harness for the Anthropic tool-reference integrity suites: a fake
 * Anthropic client that captures the outgoing request, message fixtures, and
 * block selectors over the captured payload.
 */
export interface CapturedRequest {
	params: Record<string, unknown>;
}

export function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

export function finalTextResponse(): Response {
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

export function createFakeAnthropicClient(captured: CapturedRequest): Anthropic {
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

export function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

export function toolResultMessage(
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

export function makeTool(name: string): Tool {
	return {
		name,
		description: `Test tool ${name}`,
		parameters: Type.Object({ input: Type.Optional(Type.String()) }),
	};
}

export async function captureParams(
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

export interface Block {
	type: string;
	id?: string;
	name?: string;
	tool_use_id?: string;
	text?: string;
	content?: unknown;
}

export function messagesOf(params: Record<string, unknown>): Array<{ role: string; content: unknown }> {
	return params.messages as Array<{ role: string; content: unknown }>;
}

export function blocksOf(message: { content: unknown }): Block[] {
	return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

export function allBlocks(params: Record<string, unknown>): Block[] {
	return messagesOf(params).flatMap((message) => blocksOf(message));
}

export function toolUseBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "tool_use");
}

export function toolResultBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "tool_result");
}

export function textBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "text");
}

export function toolNamesIn(params: Record<string, unknown>): string[] {
	const tools = (params.tools ?? []) as Array<{ name: string }>;
	return tools.map((tool) => tool.name);
}

/**
 * A same-model assistant turn that ran Anthropic's native tool search. The
 * result block replays verbatim on the next request, so the names it references
 * must still resolve against that request's `tools` array.
 */
export function nativeSearchTurn(referenceNames: string[], useId = "srvtoolu_search"): AssistantMessage {
	return {
		...fauxAssistantMessage("native search"),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		content: [
			{
				type: "providerNative",
				subtype: "server_tool_use",
				raw: { type: "server_tool_use", id: useId, name: "tool_search_tool_bm25", input: { query: "memory" } },
			},
			{
				type: "providerNative",
				subtype: "tool_search_tool_result",
				raw: {
					type: "tool_search_tool_result",
					tool_use_id: useId,
					content: {
						type: "tool_search_tool_search_result",
						tool_references: referenceNames.map((tool_name) => ({ type: "tool_reference", tool_name })),
					},
				},
			},
		],
	};
}

export function nativeSearchResultBlocks(
	params: Record<string, unknown>,
): Array<{ tool_use_id?: string; content?: unknown }> {
	return allBlocks(params).filter((block) => block.type === "tool_search_tool_result") as Array<{
		tool_use_id?: string;
		content?: unknown;
	}>;
}

export function nativeSearchReferenceNames(params: Record<string, unknown>): string[] {
	return nativeSearchResultBlocks(params).flatMap((block) => {
		const content = block.content as { tool_references?: Array<{ tool_name?: string }> } | undefined;
		return (content?.tool_references ?? []).map((reference) => reference.tool_name ?? "");
	});
}
