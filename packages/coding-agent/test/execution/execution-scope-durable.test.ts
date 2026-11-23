// senpi#5867 review of #6032: a session's execution scope is its durable identity, so a re-opened session's re-dispatched
// call reaches the hand's record of it (the hand refuses one execution id under two scopes).
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { bindPipelineWitness } from "../../src/core/execution/pipeline-witness.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

it("two bindings of the same durable session, as a re-open makes, name the same execution scope", () => {
	const scopeOf = (manager: SessionManager) => {
		const agent = new Agent({ streamFn: streamSimple });
		bindPipelineWitness(agent, manager, () => "/work");
		return agent.getExecutionScope?.();
	};
	const id = SessionManager.inMemory().getSessionId();

	const first = scopeOf(SessionManager.inMemory("/work", { id }));
	const reopened = scopeOf(SessionManager.inMemory("/work", { id }));
	const other = scopeOf(SessionManager.inMemory());

	expect(reopened).toEqual(first);
	expect(other?.id).not.toBe(first?.id);
	// The hand keys on the scope and never learns the session (R16).
	expect(first?.id).not.toBe(id);
});
