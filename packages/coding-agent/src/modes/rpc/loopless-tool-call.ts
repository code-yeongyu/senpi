import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";

function errorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

/**
 * Runs one tool call the way the agent loop runs a model-issued one up to its hooks (`runToolCall`, agent-loop.ts):
 * argument preparation and schema validation, then the tool. Invalid arguments and a failing tool come back as an
 * `isError` result, never a rejection (senpi#5413).
 */
export async function runLooplessToolCall(
	tool: AgentTool,
	call: { readonly toolCallId: string; readonly params: unknown; readonly signal?: AbortSignal },
): Promise<AgentToolResult<unknown>> {
	const { toolCallId, signal } = call;
	try {
		const prepared = tool.prepareArguments ? tool.prepareArguments(call.params) : call.params;
		const toolCall = { type: "toolCall", id: toolCallId, name: tool.name, arguments: prepared } as ToolCall;
		const args = validateToolArguments(tool, toolCall);
		return await tool.execute(toolCallId, args as never, signal, undefined);
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
}
