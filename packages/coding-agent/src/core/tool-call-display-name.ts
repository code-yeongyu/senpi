import type { AgentEvent } from "@earendil-works/pi-agent-core";

export type AgentMessageUpdateEvent = Extract<AgentEvent, { type: "message_update" }>;

/**
 * A `message_update` as the session publishes it. `toolcall_start` and
 * `toolcall_end` carry `resolvedToolName`: the tool the call will run, by the
 * rule the agent loop applies, so a client titles the call correctly before
 * `tool_execution_start` (a gateway-namespaced `mcp__<id>__Edit` streams as `edit`).
 */
export type SessionMessageUpdateEvent = AgentMessageUpdateEvent & { resolvedToolName?: string };

function streamedToolCallName(event: AgentMessageUpdateEvent): string | undefined {
	const update = event.assistantMessageEvent;
	if (update.type === "toolcall_end") return update.toolCall.name;
	if (update.type !== "toolcall_start") return undefined;
	const block = update.partial.content[update.contentIndex];
	return block?.type === "toolCall" && block.name.length > 0 ? block.name : undefined;
}

export function withResolvedToolName(
	event: AgentMessageUpdateEvent,
	resolve: (requested: string) => string,
): SessionMessageUpdateEvent {
	const requested = streamedToolCallName(event);
	return requested === undefined ? event : { ...event, resolvedToolName: resolve(requested) };
}
