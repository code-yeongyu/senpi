import {
	type AssistantMessage,
	getAssistantCapture,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
	? WithoutPartial<T> & { id: string; toolName: string }
	: WithoutPartial<T>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type AssistantCapture = NonNullable<ReturnType<typeof getAssistantCapture>>;
type JsonMessageUpdateEvent = {
	type: "message_update";
	usage: Usage;
	assistantMessageEvent: ToJsonAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
	resolvedToolName?: string;
};

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = Exclude<AgentSessionEvent, { type: "message_update" }> | JsonMessageUpdateEvent;

/** The engine-staged block-seed projection (senpi#4272, R3.C6.2); no public destination selects it before S17. */
export interface BlockSeedOptions {
	readonly blockSeeds: 1;
}

type SeededAssistantEvent =
	| { type: "start"; seed: { message: AssistantMessage } }
	| { type: "text_start"; contentIndex: number; seed: { block: TextContent; coveredCodeUnits: number } }
	| { type: "thinking_start"; contentIndex: number; seed: { block: ThinkingContent; coveredCodeUnits: number } }
	| {
			type: "toolcall_start";
			contentIndex: number;
			id: string;
			toolName: string;
			seed: { block: ToolCall; rawArgumentPrefix: string; parsedThrough: number; coveredCodeUnits: number };
	  }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string; offset: number }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; offset: number; parsedThrough: number }
	| { type: "text_end"; contentIndex: number; content: string; block: TextContent }
	| { type: "thinking_end"; contentIndex: number; content: string; block: ThinkingContent }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| { type: "done"; reason: string; message: AssistantMessage }
	| { type: "error"; reason: string; error: AssistantMessage };

export type SeededJsonMessageUpdateEvent = Omit<MessageUpdateEvent, "message" | "assistantMessageEvent"> & {
	usage: Usage;
	messageMetadata?: AssistantCapture["metadata"];
	assistantMessageEvent: SeededAssistantEvent;
};
export type SeededJsonAgentSessionEvent =
	| Exclude<AgentSessionEvent, { type: "message_update" }>
	| SeededJsonMessageUpdateEvent;

function toJsonAssistantMessageEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		if (toolCall?.type !== "toolCall") {
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}

	if (!("partial" in event)) {
		return event;
	}

	const { partial: _partial, ...deltaEvent } = event;
	return deltaEvent;
}

/**
 * Builds a seeded assistant event from the producer-time capture only: an ordinary delta reads its index, its
 * delta string and the capture, never the shared partial, the block or the parsed arguments.
 */
function toSeededAssistantEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
	capture: AssistantCapture,
): SeededAssistantEvent | undefined {
	if (event.type === "start") return capture.message && { type: "start", seed: { message: capture.message } };
	if (event.type === "done") return { type: "done", reason: event.reason, message: event.message };
	if (event.type === "error") return { type: "error", reason: event.reason, error: event.error };
	const contentIndex = capture.contentIndex ?? event.contentIndex;
	if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
		const { offset, parsedThrough } = capture;
		if (offset === undefined) return undefined;
		if (event.type !== "toolcall_delta") return { type: event.type, contentIndex, delta: event.delta, offset };
		if (parsedThrough === undefined) return undefined;
		return { type: event.type, contentIndex, delta: event.delta, offset, parsedThrough };
	}
	const { block, coveredCodeUnits } = capture;
	if (event.type === "toolcall_end")
		return block?.type === "toolCall" ? { type: event.type, contentIndex, toolCall: block } : undefined;
	if (event.type === "text_end")
		return block?.type === "text" ? { type: event.type, contentIndex, content: event.content, block } : undefined;
	if (event.type === "thinking_end")
		return block?.type === "thinking" ? { type: event.type, contentIndex, content: event.content, block } : undefined;
	if (coveredCodeUnits === undefined) return undefined;
	if (event.type === "text_start")
		return block?.type === "text" ? { type: event.type, contentIndex, seed: { block, coveredCodeUnits } } : undefined;
	if (event.type === "thinking_start")
		return block?.type === "thinking"
			? { type: event.type, contentIndex, seed: { block, coveredCodeUnits } }
			: undefined;
	const { rawArgumentPrefix, parsedThrough } = capture;
	if (block?.type !== "toolCall" || rawArgumentPrefix === undefined || parsedThrough === undefined) return undefined;
	return {
		type: event.type,
		contentIndex,
		id: block.id,
		toolName: block.name,
		seed: { block, rawArgumentPrefix, parsedThrough, coveredCodeUnits },
	};
}

/**
 * An assistant record with no capture has no seeded form (`undefined`): its producer captured nothing, so any
 * seed would be read from the live partial and could already hold later bytes. Identity is never invented.
 */
function toSeededJsonEvent(event: AgentSessionEvent): SeededJsonAgentSessionEvent | undefined {
	if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant") {
		const message = getAssistantCapture(event)?.message;
		if (message) return { ...event, message };
		// The terminal message is complete when emitted; only an uncaptured start may already hold later bytes.
		return event.type === "message_end" ? event : undefined;
	}
	if (event.type !== "message_update") return event;
	const capture = getAssistantCapture(event);
	const assistantMessageEvent = capture && toSeededAssistantEvent(event.assistantMessageEvent, capture);
	if (!capture || !assistantMessageEvent) return undefined;
	const { message: _message, assistantMessageEvent: _event, ...outer } = event;
	const changed = capture.metadata !== undefined && Object.keys(capture.metadata).length > 0;
	return {
		...outer,
		usage: capture.usage,
		...(changed ? { messageMetadata: capture.metadata } : {}),
		assistantMessageEvent,
	};
}

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message. Cumulative usage,
 * tool-call ids, and tool names remain available because their size is constant.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(
	event: AgentSessionEvent,
	options: BlockSeedOptions,
): SeededJsonAgentSessionEvent | undefined;
export function toJsonEvent(
	event: AgentSessionEvent,
	options?: BlockSeedOptions,
): JsonAgentSessionEvent | SeededJsonAgentSessionEvent | undefined {
	if (options) return toSeededJsonEvent(event);
	if (event.type !== "message_update") {
		return event;
	}
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}

	return {
		type: "message_update",
		usage: event.message.usage,
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
		...(event.resolvedToolName === undefined ? {} : { resolvedToolName: event.resolvedToolName }),
	};
}
