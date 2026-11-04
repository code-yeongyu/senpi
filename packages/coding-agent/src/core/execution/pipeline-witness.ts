import { randomUUID } from "node:crypto";
import { type Agent, createPreparedToolHost, type ExecutionScope } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { type ExecutionPipelineConfig, resolveExecutionPipeline } from "./pipeline-config.ts";

/**
 * Bind the execution scope and the session's pipeline: prepared by default (S21a), the loop's own scheduler for `legacy`.
 * The default keeps a ToolHost the session was built with; naming `prepared` refuses to replace it. Receipts are written
 * only through an explicitly configured `Agent.onExecutionPipeline` sink: this binding installs no default writer, so a
 * session's entries stay unchanged.
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
	if (config.pipeline !== "prepared") return;
	if (agent.toolHost === undefined) agent.toolHost = createPreparedToolHost(agent);
	else if (config.named)
		throw new Error("SENPI_EXECUTION_PIPELINE=prepared cannot replace the ToolHost this session was built with");
}
