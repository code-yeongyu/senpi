import { randomUUID } from "node:crypto";
import type { Agent, ExecutionScope } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { createPreparedToolHost, requestedExecutionPipeline } from "./pipeline-prepared.ts";

/** The session entry type of a pipeline receipt (`{ pipeline, toolCallId }`), read by the EQ witness. */
export const PIPELINE_WITNESS_ENTRY_TYPE = "execution-pipeline";

/**
 * Bind the execution scope. With `SENPI_EXECUTION_PIPELINE` unset, nothing else changes: no receipt writer and the loop's
 * own scheduler. With it set, every model-issued call writes a receipt entry (unless a sink is already configured), and
 * `prepared` runs the batch through the prepared pipeline (S18b).
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
	const pipeline = requestedExecutionPipeline();
	if (pipeline === undefined) return;
	agent.onExecutionPipeline ??= (witness) => {
		manager.appendCustomEntry(PIPELINE_WITNESS_ENTRY_TYPE, witness);
	};
	if (pipeline !== "prepared") return;
	if (agent.toolHost !== undefined)
		throw new Error("SENPI_EXECUTION_PIPELINE=prepared cannot replace the ToolHost this session was built with");
	agent.toolHost = createPreparedToolHost(agent);
}
