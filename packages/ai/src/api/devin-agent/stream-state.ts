/**
 * Cascade delta bookkeeping.
 *
 * One Cascade response frame can carry a thinking delta, a text delta and a
 * finished tool call at once, and blocks are implicit: the server never opens
 * or closes them. This module owns the open-block state so the adapter emits
 * senpi's start/delta/end triples in the right order.
 */

import type { AssistantMessage, ToolCall } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { parseStreamingJson } from "../../utils/json-parse.ts";
import { type GetChatMessageResponse, StopReason } from "./gen/cascade_pb.ts";

export interface DevinToolCallState {
	contentIndex: number;
	/** Raw JSON accumulated across chunks; the content block holds the parsed view. */
	argumentsJson: string;
}

export interface DevinStreamState {
	textIndex: number | undefined;
	thinkingIndex: number | undefined;
	toolCalls: Map<string, DevinToolCallState>;
	/** Chunks after the first arrive without an id; they belong to this call. */
	activeToolCallId: string | undefined;
}

export function createDevinStreamState(): DevinStreamState {
	return { textIndex: undefined, thinkingIndex: undefined, toolCalls: new Map(), activeToolCallId: undefined };
}

export function applyDevinResponse(
	message: GetChatMessageResponse,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	state: DevinStreamState,
): void {
	if (message.messageId && !output.responseId) output.responseId = message.messageId;
	if (message.actualModelUid) output.responseModel = message.actualModelUid;

	if (message.deltaThinking) appendThinking(message, output, events, state);
	if (message.deltaText) appendText(message.deltaText, output, events, state);
	for (const call of message.deltaToolCalls) appendToolCall(call, output, events, state);
	if (message.usage) applyUsage(message, output);
	if (message.stopReason !== StopReason.UNSPECIFIED) output.stopReason = mapStopReason(message.stopReason);
}

function appendThinking(
	message: GetChatMessageResponse,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	state: DevinStreamState,
): void {
	// A thinking block interleaved after text starts a new block, matching the
	// order Cascade streamed it in.
	if (state.textIndex !== undefined) closeText(output, events, state);
	if (state.thinkingIndex === undefined) {
		output.content.push({ type: "thinking", thinking: "", ...(message.thinkingRedacted ? { redacted: true } : {}) });
		state.thinkingIndex = output.content.length - 1;
		events.push({ type: "thinking_start", contentIndex: state.thinkingIndex, partial: output });
	}
	const block = output.content[state.thinkingIndex];
	if (block?.type !== "thinking") return;
	block.thinking += message.deltaThinking;
	if (message.deltaSignature) block.thinkingSignature = message.deltaSignature;
	events.push({
		type: "thinking_delta",
		contentIndex: state.thinkingIndex,
		delta: message.deltaThinking,
		partial: output,
	});
}

function appendText(
	delta: string,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	state: DevinStreamState,
): void {
	if (state.thinkingIndex !== undefined) closeThinking(output, events, state);
	if (state.textIndex === undefined) {
		output.content.push({ type: "text", text: "" });
		state.textIndex = output.content.length - 1;
		events.push({ type: "text_start", contentIndex: state.textIndex, partial: output });
	}
	const block = output.content[state.textIndex];
	if (block?.type !== "text") return;
	block.text += delta;
	events.push({ type: "text_delta", contentIndex: state.textIndex, delta, partial: output });
}

function appendToolCall(
	call: { id: string; name: string; argumentsJson: string },
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	state: DevinStreamState,
): void {
	if (state.textIndex !== undefined) closeText(output, events, state);
	if (state.thinkingIndex !== undefined) closeThinking(output, events, state);
	const toolCallId = call.id || state.activeToolCallId;
	if (!toolCallId) return;
	state.activeToolCallId = toolCallId;
	let entry = state.toolCalls.get(toolCallId);
	if (entry === undefined) {
		const block: ToolCall = { type: "toolCall", id: toolCallId, name: call.name, arguments: {} };
		output.content.push(block);
		entry = { contentIndex: output.content.length - 1, argumentsJson: "" };
		state.toolCalls.set(toolCallId, entry);
		events.push({ type: "toolcall_start", contentIndex: entry.contentIndex, partial: output });
	}
	const block = output.content[entry.contentIndex];
	if (block?.type !== "toolCall") return;
	if (call.name) block.name = call.name;
	if (!call.argumentsJson) return;
	// A chunk either repeats everything so far plus new bytes, or carries only the new bytes.
	const accumulated = call.argumentsJson.startsWith(entry.argumentsJson)
		? call.argumentsJson
		: entry.argumentsJson + call.argumentsJson;
	const delta = accumulated.slice(entry.argumentsJson.length);
	entry.argumentsJson = accumulated;
	block.arguments = parseStreamingJson(accumulated);
	if (delta) events.push({ type: "toolcall_delta", contentIndex: entry.contentIndex, delta, partial: output });
}

function closeText(output: AssistantMessage, events: AssistantMessageEventStream, state: DevinStreamState): void {
	const index = state.textIndex;
	if (index === undefined) return;
	const block = output.content[index];
	state.textIndex = undefined;
	if (block?.type === "text")
		events.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
}

function closeThinking(output: AssistantMessage, events: AssistantMessageEventStream, state: DevinStreamState): void {
	const index = state.thinkingIndex;
	if (index === undefined) return;
	const block = output.content[index];
	state.thinkingIndex = undefined;
	if (block?.type === "thinking")
		events.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
}

function applyUsage(message: GetChatMessageResponse, output: AssistantMessage): void {
	const usage = message.usage;
	if (!usage) return;
	output.usage.input = Number(usage.inputTokens);
	output.usage.output = Number(usage.outputTokens);
	output.usage.cacheRead = Number(usage.cacheReadTokens);
	output.usage.cacheWrite = Number(usage.cacheWriteTokens);
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

/** Cascade's stop vocabulary reduced to senpi's. */
function mapStopReason(reason: StopReason): AssistantMessage["stopReason"] {
	switch (reason) {
		case StopReason.FUNCTION_CALL:
			return "toolUse";
		case StopReason.MAX_TOKENS:
		case StopReason.MAX_NEWLINES:
			return "length";
		case StopReason.ERROR:
		case StopReason.CONTENT_FILTER:
			return "error";
		default:
			return "stop";
	}
}
