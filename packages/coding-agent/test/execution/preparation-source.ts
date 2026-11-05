import type { Agent } from "@earendil-works/pi-agent-core";

/** A session's agent as a prepared-pipeline source: every AgentSession installs `afterToolFreeze` (senpi#5795). */
export function sessionPreparationSource(
	agent: Agent,
): Agent & { afterToolFreeze: NonNullable<Agent["afterToolFreeze"]> } {
	if (agent.afterToolFreeze === undefined) throw new Error("the session did not install afterToolFreeze");
	return agent as Agent & { afterToolFreeze: NonNullable<Agent["afterToolFreeze"]> };
}
