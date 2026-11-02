import type { AgentTool, AgentToolCall } from "./types.ts";

export type ToolArgumentShim = (args: unknown) => unknown;

// The shim runs against a detached copy because several shims normalize by mutating the object
// they were handed (eval's summary clamp, the harness edit shim's `edits` coercion) and return
// that same reference. That object is the one the assistant message holds, so an in-place
// normalization rewrites the answer the provider actually produced: the Claude SDK continuity
// fingerprint then reports `assistant_rewritten` and the next turn re-sends the whole
// conversation (senpi#1472). `validateToolArguments` already detaches for the same reason.
export function prepareToolArguments(shim: ToolArgumentShim | undefined, args: unknown): unknown {
	if (!shim) return args;
	return shim(structuredClone(args));
}

export function prepareAgentToolCallArguments(tool: AgentTool, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) return toolCall;
	return {
		...toolCall,
		arguments: prepareToolArguments(tool.prepareArguments, toolCall.arguments) as AgentToolCall["arguments"],
	};
}
