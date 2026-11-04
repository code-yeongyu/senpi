import type { AgentLoopConfig } from "../../types.ts";
import { resolveToolNameAlias } from "../../tool-name-alias.ts";
import type { PreparationPipeline } from "./executor-types.ts";

/**
 * The preparation steps an agent's loop runs today, read from the agent at call time: its resolver (lazy activation),
 * its `beforeToolCall` / `afterToolCall` (the session's `tool_call` and `tool_result` chains) and its removed-tool
 * hints. Building this pipeline installs nothing on the agent.
 */
/** What preparation reads from an agent or a loop config, at call time. */
export type PreparationSource = Pick<
	AgentLoopConfig,
	"resolveUnknownToolCall" | "beforeToolCall" | "afterToolCall" | "removedToolHints"
>;

export function agentPreparationPipeline(agent: PreparationSource): PreparationPipeline {
	return {
		resolve: async (call, context) => {
			const tools = context.tools ?? [];
			const exact = tools.find((tool) => tool.name === call.name);
			if (exact) return exact;
			const resolved = await agent.resolveUnknownToolCall?.(call.name, context);
			if (resolved) return resolved;
			const aliased = resolveToolNameAlias(
				call.name,
				tools.map((tool) => tool.name),
			);
			return tools.find((tool) => tool.name === aliased);
		},
		beforeToolCall: async (context, signal) => agent.beforeToolCall?.(context, signal),
		afterToolCall: async (context, signal) => agent.afterToolCall?.(context, signal),
		removedToolHint: (name) => agent.removedToolHints?.[name],
	};
}
