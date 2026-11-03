import type { ExtensionRunner } from "../../core/extensions/runner.ts";
import type { LooplessToolHandlers } from "./loopless-tool-call.ts";

/** A loopless runtime's own extensions' `tool_call`/`tool_result` handlers, emitted as a session emits them. */
export function extensionToolHandlers(runner: ExtensionRunner): LooplessToolHandlers {
	return {
		beforeToolCall: ({ toolName, toolCallId, input }) =>
			runner.hasHandlers("tool_call")
				? runner.emitToolCall({ type: "tool_call", toolName, toolCallId, input })
				: Promise.resolve(undefined),
		afterToolCall: ({ toolName, toolCallId, input, result, isError }) =>
			runner.hasHandlers("tool_result")
				? runner.emitToolResult({
						type: "tool_result",
						toolName,
						toolCallId,
						input,
						content: result.content,
						details: result.details,
						...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
						isError,
						usage: result.usage,
					})
				: Promise.resolve(undefined),
	};
}
