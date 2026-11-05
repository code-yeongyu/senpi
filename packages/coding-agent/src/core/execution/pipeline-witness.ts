import { randomUUID } from "node:crypto";
import type { Agent, ExecutionScope } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { type ExecutionPipelineConfig, resolveExecutionPipeline } from "./pipeline-config.ts";

/**
 * Bind the execution scope. The loop has one pipeline, the prepared one, so nothing is installed for it; naming
 * `prepared` still refuses to replace a ToolHost the session was built with. Receipts are written only through an
 * explicitly configured `Agent.onExecutionPipeline` sink: this binding installs no default writer.
 */
export function bindPipelineWitness(
	agent: Agent,
	manager: SessionManager,
	root: () => string,
	config: ExecutionPipelineConfig = resolveExecutionPipeline(),
): void {
	let owner: string | undefined;
	let scope: ExecutionScope | undefined;
	agent.getExecutionScope = () => {
		const current = manager.getSessionId();
		if (owner !== current || scope === undefined) {
			owner = current;
			scope = { id: randomUUID(), root: root() };
		}
		return scope;
	};
	if (config.named && agent.toolHost !== undefined)
		throw new Error("SENPI_EXECUTION_PIPELINE=prepared cannot replace the ToolHost this session was built with");
}
