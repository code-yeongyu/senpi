import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Conversation transform before a provider call. System prompt and tool state
 * are restored by the runner after each handler.
 */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
	/** Prepared projections may not advance state belonging to the live agent request. */
	readonly source?: "agent" | "projection";
}
