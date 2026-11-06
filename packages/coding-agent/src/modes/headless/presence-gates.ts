import type { Agent } from "@earendil-works/pi-agent-core";
import type { HeadlessPresence } from "./presence.ts";

/**
 * Parks a session's loop while a machine it depends on is offline (C2, K7; senpi#5652): each provider request waits
 * for the placement, and each tool batch on an explicit ToolHost (a split session's hand) waits for the placement and
 * the session's hands. A fused session has no ToolHost to wrap, so its tool calls run in this process as today.
 */
export function gatePresence(agent: Agent, presence: HeadlessPresence, sessionId: string): void {
	const prepareRequest = agent.prepareRequest;
	agent.prepareRequest = async (request, signal) => {
		await presence.ready(sessionId, "request", signal);
		return (await prepareRequest?.(request, signal)) ?? undefined;
	};
	const host = agent.toolHost;
	if (host === undefined) return;
	// The wrapper keeps the host's device files: a split session's extension data must stay on the hand (senpi#5839).
	const deviceFiles = host.deviceFiles?.bind(host);
	agent.toolHost = {
		execute: async (call, options) => {
			await presence.ready(sessionId, "tools", options.signal);
			return host.execute(call, options);
		},
		...(deviceFiles === undefined ? {} : { deviceFiles }),
	};
}
