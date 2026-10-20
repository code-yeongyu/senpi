import type { Api, AssistantMessage, AssistantMessageEventStream, Model, ToolCall } from "@earendil-works/pi-ai";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { SDKMessage } from "./sdk-boundary.ts";
import {
	asRecord,
	mapStopReason,
	mapToolArguments,
	type StreamBlock,
	type TextBlock,
	type ThinkingBlock,
	type ToolBlock,
	type UsageBase,
	updateUsage,
	usageBaseOf,
} from "./stream-protocol.ts";
import { mapSdkToolNameToPi } from "./tools.ts";

/** Diagnostic on the assistant message when one query streamed more than one Anthropic response. */
export const RESPONSE_RESTART_DIAGNOSTIC = "claude_sdk_oauth_response_restart";

/**
 * The Anthropic responses one query streamed. Claude Code runs a second response inside the same query when
 * the first stops at its output cap (its output-limit recovery appends a nudge and queries again) and when it
 * retries a failed request; each response numbers its content blocks from zero and reports usage from zero.
 */
export type SdkResponseTracker = {
	count: number;
	usageBase?: UsageBase;
};

export function createSdkResponseTracker(): SdkResponseTracker {
	return { count: 0 };
}

export type StreamEventContext = {
	model: Model<Api>;
	output: AssistantMessage;
	blocks: StreamBlock[];
	stream: AssistantMessageEventStream;
	customToolNameToPi: ReadonlyMap<string, string>;
	responses: SdkResponseTracker;
};

type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

function openBlock(context: StreamEventContext, block: StreamBlock, kind: "text" | "thinking" | "toolcall"): void {
	context.blocks.push(block);
	context.output.content.push(block as AssistantMessage["content"][number]);
	context.stream.push({
		type: `${kind}_start`,
		contentIndex: context.output.content.length - 1,
		partial: context.output,
	} as Parameters<AssistantMessageEventStream["push"]>[0]);
}

function startContentBlock(context: StreamEventContext, event: Extract<StreamEvent, { type: "content_block_start" }>) {
	if (event.content_block.type === "text") {
		openBlock(context, { type: "text", text: "", index: event.index } satisfies TextBlock, "text");
		return;
	}
	if (event.content_block.type === "thinking") {
		const block: ThinkingBlock = { type: "thinking", thinking: "", thinkingSignature: "", index: event.index };
		openBlock(context, block, "thinking");
		return;
	}
	if (event.content_block.type === "tool_use") {
		const block: ToolBlock = {
			type: "toolCall",
			id: event.content_block.id,
			name: mapSdkToolNameToPi(event.content_block.name, context.customToolNameToPi),
			arguments: asRecord(event.content_block.input),
			partialJson: "",
			index: event.index,
		};
		openBlock(context, block, "toolcall");
	}
}

function applyDelta(context: StreamEventContext, event: Extract<StreamEvent, { type: "content_block_delta" }>): void {
	const { blocks, stream, output } = context;
	const contentIndex = blocks.findIndex((candidate) => candidate.index === event.index);
	const block = blocks[contentIndex];
	if (event.delta.type === "text_delta" && block?.type === "text") {
		block.text += event.delta.text;
		stream.push({ type: "text_delta", contentIndex, delta: event.delta.text, partial: output });
	} else if (event.delta.type === "thinking_delta" && block?.type === "thinking") {
		block.thinking += event.delta.thinking;
		stream.push({ type: "thinking_delta", contentIndex, delta: event.delta.thinking, partial: output });
	} else if (event.delta.type === "signature_delta" && block?.type === "thinking") {
		block.thinkingSignature += event.delta.signature;
	} else if (event.delta.type === "input_json_delta" && block?.type === "toolCall") {
		block.partialJson = `${block.partialJson ?? ""}${event.delta.partial_json}`;
		block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex, delta: event.delta.partial_json, partial: output });
	}
}

function closeContentBlock(context: StreamEventContext, event: Extract<StreamEvent, { type: "content_block_stop" }>) {
	const { blocks, stream, output } = context;
	const contentIndex = blocks.findIndex((candidate) => candidate.index === event.index);
	const block = blocks[contentIndex];
	if (block?.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
	} else if (block?.type === "thinking") {
		stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
	} else if (block?.type === "toolCall") {
		block.arguments = mapToolArguments(block.name, parseStreamingJson<Record<string, unknown>>(block.partialJson));
		delete block.partialJson;
		stream.push({ type: "toolcall_end", contentIndex, toolCall: block as ToolCall, partial: output });
	}
	if (block) delete block.index;
}

/**
 * Ends every block the SDK left open, oldest first, and returns how many. The provider's own event protocol
 * must stay sequential (one open block, indices that only grow): the text-tool-call recovery middleware
 * ends the turn with "Invalid assistant content event order" otherwise. The SDK breaks that protocol when
 * Claude Code restarts a response inside the query (its output-limit continuation, a retried request) or
 * re-emits a block: the next `content_block_start` arrives without the open block's stop.
 */
function closeOpenBlocks(context: StreamEventContext): number {
	let closed = 0;
	for (const block of [...context.blocks]) {
		if (block.index === undefined) continue;
		closeContentBlock(context, { type: "content_block_stop", index: block.index });
		closed += 1;
	}
	return closed;
}

function startResponse(context: StreamEventContext, event: Extract<StreamEvent, { type: "message_start" }>): void {
	const { output, responses } = context;
	responses.count += 1;
	if (responses.count > 1) {
		// A later response continues the same assistant message: its blocks append after the earlier ones
		// (openBlock numbers them by position) and its usage adds to theirs.
		const closedBlocks = closeOpenBlocks(context);
		responses.usageBase = usageBaseOf(output);
		output.diagnostics = [
			...(output.diagnostics ?? []),
			{
				type: RESPONSE_RESTART_DIAGNOSTIC,
				timestamp: Date.now(),
				details: { response: responses.count, closedBlocks, previousStopReason: output.stopReason },
			},
		];
	}
	// Turn identity (oh-my-openagent#10547): a senpi assistant message is one Anthropic response, because the
	// SDK turn ends at the first tool_use (PreToolUse deny hook) and tool-less requests run maxTurns 1. Its
	// `message.id` is the id Claude Code writes as `message.id` on every transcript line of that response, so
	// usage readers pair the two stores by it. The first id wins on every lane (here and the SDK `assistant`
	// branch in stream.ts), so both lanes always record the same id.
	output.responseId ??= event.message.id || undefined;
	updateUsage(context.model, output, event.message.usage, responses.usageBase);
}

export function applyStreamEvent(context: StreamEventContext, event: StreamEvent): void {
	if (event.type === "message_start") {
		startResponse(context, event);
	} else if (event.type === "content_block_start") {
		closeOpenBlocks(context);
		startContentBlock(context, event);
	} else if (event.type === "content_block_delta") {
		applyDelta(context, event);
	} else if (event.type === "content_block_stop") {
		closeContentBlock(context, event);
	} else if (event.type === "message_delta") {
		context.output.stopReason = mapStopReason(event.delta.stop_reason);
		updateUsage(context.model, context.output, event.usage, context.responses.usageBase);
	}
}
