import type { AgentSessionEvent } from "../../core/agent-session.ts";

export type RpcCommandInvocationEvent = Extract<AgentSessionEvent, { type: "command_invocation" }>;
