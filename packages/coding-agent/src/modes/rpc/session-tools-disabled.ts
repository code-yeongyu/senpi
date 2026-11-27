import type { AgentSessionLaunchProfile } from "../../core/agent-session-runtime.ts";

/**
 * The typed refusal of an RPC command that would run something for a session opened with no tools
 * (`open_session.persona.tools: []`, senpi#7567): such a session can never run a process, by its model or by a client.
 */
export const RPC_ERROR_TOOLS_DISABLED = "tools_disabled";

/** Whether the session's own launch profile chose no tools; the host's process-wide flags are not this choice. */
export function sessionToolsDisabled(profile: Readonly<AgentSessionLaunchProfile> | undefined): boolean {
	return profile?.persona?.tools?.length === 0;
}
