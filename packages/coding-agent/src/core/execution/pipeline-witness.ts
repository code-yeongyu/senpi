import { randomUUID } from "node:crypto";
import type { Agent, ExecutionScope } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";

/** Bind only the execution scope and out-of-band receipt writer; the existing tool hooks stay untouched. */
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
	agent.onExecutionPipeline = (witness) => {
		manager.appendCustomEntry("execution-pipeline", witness);
	};
}
