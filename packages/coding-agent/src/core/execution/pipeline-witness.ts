import { createHash } from "node:crypto";
import type { Agent, ExecutionScope } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { type ExecutionPipelineConfig, resolveExecutionPipeline } from "./pipeline-config.ts";

/**
 * A session's execution scope id for one root: stable for the durable session and root, never the session id. A new
 * root (an allowed cwd override) gets a fresh scope, since the hand binds a scope to the root it was opened on.
 */
function executionScopeId(sessionId: string, root: string): string {
	return createHash("sha256").update(`senpi-execution-scope\0${sessionId}\0${root}`).digest("hex").slice(0, 32);
}

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
		const currentRoot = root();
		if (owner !== current || scope === undefined || scope.root !== currentRoot) {
			owner = current;
			// Durable, not per process: a re-opened or moved session re-dispatching a call of a turn must name the scope the
			// hand recorded it under (senpi#5867). Derived, not the session id itself: the hand never learns the session (R16).
			// A scope keeps the root it was bound to; a new root is a new scope.
			scope = { id: executionScopeId(current, currentRoot), root: currentRoot };
		}
		return scope;
	};
	if (config.named && agent.toolHost !== undefined)
		throw new Error("SENPI_EXECUTION_PIPELINE=prepared cannot replace the ToolHost this session was built with");
}
