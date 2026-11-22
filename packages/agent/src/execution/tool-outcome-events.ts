// The events and messages one finished tool call produces, shared by the agent loop's own scheduler and every ToolHost
// that keeps the loop's side of a batch (the prepared pipeline, S18b), so both emit exactly the same shapes.
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentToolCall, AgentToolCallOutcome, AgentToolResult } from "../types.ts";

type EventSink = (event: AgentEvent) => Promise<void> | void;

export function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

export function emitToolExecutionUpdate(
	toolCall: AgentToolCall,
	emit: EventSink,
): (partialResult: AgentToolResult<unknown>) => Promise<void> | void {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

export async function emitToolExecutionEnd(finalized: AgentToolCallOutcome, emit: EventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

export function createToolResultMessage(finalized: AgentToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

export async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: EventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}

export function shouldTerminateToolBatch(finalizedCalls: readonly AgentToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
