import { randomUUID } from "node:crypto";
import type { Agent, ExecutionScope } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { createPreparedToolHost, requestedExecutionPipeline } from "./pipeline-prepared.ts";

/**
 * Bind the execution scope. With `SENPI_EXECUTION_PIPELINE=prepared` the batch runs through the prepared pipeline (S18b);
 * any other value keeps the loop's own scheduler. Receipts are written only through an explicitly configured
 * `Agent.onExecutionPipeline` sink: this binding installs no default writer, so a session's entries stay unchanged.
 */
export function bindPipelineWitness(agent: Agent, manager: SessionManager, root: () => string): void {
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
	if (requestedExecutionPipeline() !== "prepared") return;
	if (agent.toolHost !== undefined)
		throw new Error("SENPI_EXECUTION_PIPELINE=prepared cannot replace the ToolHost this session was built with");
	agent.toolHost = createPreparedToolHost(agent);
}
