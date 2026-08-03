import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
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
	updateUsage,
} from "./stream-protocol.ts";
import { mapSdkToolNameToPi } from "./tools.ts";

export type StreamEventContext = {
	model: Model<Api>;
	output: AssistantMessage;
	blocks: StreamBlock[];
	stream: AssistantMessageEventStream;
	customToolNameToPi: ReadonlyMap<string, string>;
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
		stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
	}
	if (block) delete block.index;
}

export function applyStreamEvent(context: StreamEventContext, event: StreamEvent): void {
	if (event.type === "message_start") {
		updateUsage(context.model, context.output, event.message.usage);
	} else if (event.type === "content_block_start") {
		startContentBlock(context, event);
	} else if (event.type === "content_block_delta") {
		applyDelta(context, event);
	} else if (event.type === "content_block_stop") {
		closeContentBlock(context, event);
	} else if (event.type === "message_delta") {
		context.output.stopReason = mapStopReason(event.delta.stop_reason);
		updateUsage(context.model, context.output, event.usage);
	}
}
