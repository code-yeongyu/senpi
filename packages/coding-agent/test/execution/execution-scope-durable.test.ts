// senpi#5867 review of #6032: a session's execution scope is durable per session and root, so a re-opened session's
// re-dispatched call reaches the hand's record of it (the hand refuses one execution id under two scopes), while an
// allowed cwd override starts new-root work in a fresh scope (the hand binds a scope to its root).
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { bindPipelineWitness } from "../../src/core/execution/pipeline-witness.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const bound = (manager: SessionManager, root: () => string) => {
	const agent = new Agent({ streamFn: streamSimple });
	bindPipelineWitness(agent, manager, root);
	return agent;
};

it("two bindings of the same durable session at one root, as a re-open makes, name the same execution scope", () => {
	const id = SessionManager.inMemory().getSessionId();

	const first = bound(SessionManager.inMemory("/work", { id }), () => "/work").getExecutionScope?.();
	const reopened = bound(SessionManager.inMemory("/work", { id }), () => "/work").getExecutionScope?.();
	const other = bound(SessionManager.inMemory(), () => "/work").getExecutionScope?.();

	expect(reopened).toEqual(first);
	expect(other?.id).not.toBe(first?.id);
	// The hand keys on the scope and never learns the session (R16).
	expect(first?.id).not.toBe(id);
});

it("an allowed cwd override gets a fresh scope bound to the new root; the old root keeps its scope", () => {
	let root = "/work";
	const agent = bound(SessionManager.inMemory("/work"), () => root);
	const before = agent.getExecutionScope?.();

	root = "/elsewhere";
	const after = agent.getExecutionScope?.();
	root = "/work";
	const back = agent.getExecutionScope?.();

	expect(after).toMatchObject({ root: "/elsewhere" });
	expect(after?.id).not.toBe(before?.id);
	expect(back).toEqual(before);
});
