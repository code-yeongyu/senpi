import type { ExtensionRunner } from "../../core/extensions/runner.ts";
import { forwardToolEvents } from "../../core/extensions/two-sided-forwarding.ts";
import type { LooplessToolHandlers } from "./loopless-tool-call.ts";

/**
 * A loopless runtime's own extensions' `tool_call`/`tool_result` handlers, emitted as a session emits them. On a hand
 * (a call that carries its nested requests), a two-sided extension's handlers are forwarded to the loop that owns the
 * call instead of running here (S29).
 */
export function extensionToolHandlers(runner: ExtensionRunner): LooplessToolHandlers {
	const twoSided = runner.twoSidedExtensionPaths();
	const options = (nested: Parameters<typeof forwardToolEvents>[1] | undefined) =>
		nested === undefined || twoSided.size === 0 ? {} : { forward: forwardToolEvents(twoSided, nested) };
	return {
		beforeToolCall: ({ toolName, toolCallId, input, nested }) =>
			runner.hasHandlers("tool_call")
				? runner.emitToolCall({ type: "tool_call", toolName, toolCallId, input }, options(nested))
				: Promise.resolve(undefined),
		afterToolCall: ({ toolName, toolCallId, input, result, isError, nested }) =>
			runner.hasHandlers("tool_result")
				? runner.emitToolResult(
						{
							type: "tool_result",
							toolName,
							toolCallId,
							input,
							content: result.content,
							details: result.details,
							...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
							isError,
							usage: result.usage,
						},
						options(nested),
					)
				: Promise.resolve(undefined),
	};
}
