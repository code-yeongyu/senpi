/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDispatcher } from "../tool-dispatch/tool-dispatcher.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { kernelToolInvokerStorage } from "./kernel-tools-context.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { ExtensionContext, RegisteredTool } from "./types.ts";

type ToolContextFactory = (signal: AbortSignal | undefined) => {
	readonly context: ExtensionContext;
	dispose(): void;
};

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(
	registeredTool: RegisteredTool,
	runner: ExtensionRunner,
	createToolContext?: ToolContextFactory,
	dispatcher?: ToolDispatcher,
): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, undefined, dispatcher);
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const activeBefore = runner.getActiveTools();
			const invocation = createToolContext?.(signal);
			let result: AgentToolResult<unknown>;
			try {
				const context = runner.createToolContext(toolCallId, signal, invocation?.context);
				result = dispatcher
					? await dispatcher.run({
							definition: registeredTool.definition,
							toolCallId,
							params,
							signal,
							onUpdate,
							ctx: context,
							sourcePath: registeredTool.sourceInfo.path,
						})
					: await kernelToolInvokerStorage.run({ sessionId: context.sessionManager.getSessionId() }, () =>
							registeredTool.definition.execute(toolCallId, params, signal, onUpdate, context),
						);
			} finally {
				invocation?.dispose();
			}
			const activeAfter = runner.getActiveTools();
			if (!activeBefore.every((name) => activeAfter.includes(name))) return result;

			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return result;
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(
	registeredTools: RegisteredTool[],
	runner: ExtensionRunner,
	createToolContext?: ToolContextFactory,
	dispatcher?: ToolDispatcher,
): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner, createToolContext, dispatcher));
}
