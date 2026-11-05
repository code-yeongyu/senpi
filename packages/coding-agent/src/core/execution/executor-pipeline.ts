import { type Agent, resolveToolNameAlias } from "@earendil-works/pi-agent-core";
import { transferDispatchApproval } from "../extensions/builtin/permission-system/dispatch.ts";
import { transferApprovedMonitorParent } from "../extensions/builtin/terminal/monitor-permission.ts";
import type { PreparationPipeline } from "./executor-types.ts";

/**
 * The preparation steps an agent's loop runs today, read from the agent at call time: its resolver (lazy activation),
 * its `beforeToolCall` / `afterToolCall` (the session's `tool_call` and `tool_result` chains) and its removed-tool
 * hints. Building this pipeline installs nothing on the agent.
 */
export function agentPreparationPipeline(agent: Agent): PreparationPipeline {
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
		// The legacy loop handed the preflight's own arguments object to execute; the prepared executor runs a frozen
		// copy, so the preflight's object-bound facts move to that copy here (senpi#5795).
		afterFreeze: (prepared, frozen) => {
			transferDispatchApproval(prepared, frozen);
			transferApprovedMonitorParent(prepared, frozen);
		},
	};
}
