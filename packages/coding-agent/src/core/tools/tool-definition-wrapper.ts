import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import type { ToolDispatcher, ToolUnavailableDetails } from "../tool-dispatch/tool-dispatcher.ts";

/** Creates the context for one tool call. */
export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionToolContext;

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: ToolContextFactory,
	dispatcher?: ToolDispatcher,
): AgentTool<any, TDetails | ToolUnavailableDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		freeform: definition.freeform,
		outputSchema: definition.outputSchema,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionToolContext) => {
			const resolved = ctx ?? ctxFactory?.(toolCallId, signal);
			// Upstream idiom: a definition wrapped without a context factory legitimately gets no
			// context (see the ToolDefinition docs); the interface requires the parameter, hence the cast.
			const context = resolved as ExtensionToolContext;
			if (dispatcher) return dispatcher.run({ definition, toolCallId, params, signal, onUpdate, ctx: context });
			return definition.execute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: ToolContextFactory,
	dispatcher?: ToolDispatcher,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory, dispatcher));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		freeform: tool.freeform,
		outputSchema: tool.outputSchema,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
