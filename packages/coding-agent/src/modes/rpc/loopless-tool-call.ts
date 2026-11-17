import type { AgentTool, AgentToolResult, NestedRequest } from "@earendil-works/pi-agent-core";
import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolCallEventResult, ToolResultEventResult } from "../../core/extensions/types.ts";

function errorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

/** The extensions' tool handlers a call runs around its tool, as a session runs them (`agent-session.ts`). */
export interface LooplessToolHandlers {
	/** `tool_call` handlers; `input` is the validated arguments object, which a handler may rewrite in place. */
	beforeToolCall(event: {
		readonly toolName: string;
		readonly toolCallId: string;
		readonly input: Record<string, unknown>;
		readonly nested?: NestedRequest;
	}): Promise<ToolCallEventResult | undefined>;
	afterToolCall(event: {
		readonly toolName: string;
		readonly toolCallId: string;
		readonly input: Record<string, unknown>;
		readonly result: AgentToolResult<unknown>;
		readonly isError: boolean;
		readonly nested?: NestedRequest;
	}): Promise<ToolResultEventResult | undefined>;
}

function withOverride(result: AgentToolResult<unknown>, override: ToolResultEventResult): AgentToolResult<unknown> {
	const structuredContent = override.structuredContent ?? (override.content ? undefined : result.structuredContent);
	const next: AgentToolResult<unknown> = {
		...result,
		content: override.content ?? result.content,
		details: override.details ?? result.details,
		usage: override.usage ?? result.usage,
		isError: override.isError ?? result.isError === true,
	};
	if (structuredContent === undefined) delete next.structuredContent;
	else next.structuredContent = structuredContent;
	return next;
}

/**
 * Runs one tool call the way the agent loop runs a model-issued one (`runToolCall`, agent-loop.ts): argument preparation
 * and schema validation; then, when `handlers` are given, the `tool_call` handlers, where a block, an abort or a handler
 * that throws stops the call before the tool runs (fail-closed, as a session does); the tool; and the `tool_result`
 * handlers. Invalid arguments, a blocked call and a failing tool come back as an `isError` result, never a rejection
 * (senpi#5413).
 */
export async function runLooplessToolCall(
	tool: AgentTool,
	call: {
		readonly toolCallId: string;
		readonly params: unknown;
		readonly signal?: AbortSignal;
		/** The running call's requests back to the loop that owns it (on a hand). */
		readonly nested?: NestedRequest;
	},
	handlers?: LooplessToolHandlers,
): Promise<AgentToolResult<unknown>> {
	const { toolCallId, signal } = call;
	const nested = call.nested === undefined ? {} : { nested: call.nested };
	let args: Record<string, unknown>;
	try {
		const prepared = tool.prepareArguments ? tool.prepareArguments(call.params) : call.params;
		const toolCall = { type: "toolCall", id: toolCallId, name: tool.name, arguments: prepared } as ToolCall;
		args = validateToolArguments(tool, toolCall) as Record<string, unknown>;
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
	if (handlers) {
		let before: ToolCallEventResult | undefined;
		try {
			before = await handlers.beforeToolCall({ toolName: tool.name, toolCallId, input: args, ...nested });
		} catch (error) {
			return errorResult(
				error instanceof Error ? error.message : `Extension failed, blocking execution: ${String(error)}`,
			);
		}
		if (signal?.aborted) return errorResult("Operation aborted");
		if (before?.block) {
			const blocked = errorResult(before.reason || "Tool execution was blocked");
			if (before.terminate === true) blocked.terminate = true;
			return blocked;
		}
	}
	let result: AgentToolResult<unknown>;
	try {
		result = await tool.execute(toolCallId, args as never, signal, undefined);
	} catch (error) {
		result = errorResult(error instanceof Error ? error.message : String(error));
	}
	if (!handlers) return result;
	try {
		const override = await handlers.afterToolCall({
			toolName: tool.name,
			toolCallId,
			input: args,
			result,
			isError: result.isError === true,
			...nested,
		});
		return override ? withOverride(result, override) : result;
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
}
