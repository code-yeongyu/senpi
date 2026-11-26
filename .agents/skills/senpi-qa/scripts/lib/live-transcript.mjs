// Readers over one live-session record's persisted transcript entries and RPC events, shared by the SC-LIVE checks
// (live-invariants.mjs, live-hook-invariants.mjs).

export const messages = (entries) => entries.filter((entry) => entry?.type === "message" && entry.message);

/** Every tool call in the transcript, in source order: { id, name, messageIndex }. */
export function transcriptCalls(entries) {
	return messages(entries).flatMap(({ message }, messageIndex) =>
		message.role === "assistant" && Array.isArray(message.content)
			? message.content
					.filter((part) => part?.type === "toolCall")
					.map((part) => ({ id: part.id, name: part.name, messageIndex }))
			: [],
	);
}

/**
 * Calls a tool ran inside another call (an eval cell's \`tool.bash\`): the engine reports them only on its
 * \`tool_hook_status\` stream, under their own ids. Each is attributed to the top-level call that was running when it
 * first appeared: { id, name, parentId }.
 */
export function nestedCalls(events) {
	const open = [];
	const topLevel = new Set(events.filter((e) => e.type === "tool_execution_start").map((e) => e.toolCallId));
	const nested = new Map();
	for (const event of events) {
		if (event.type === "tool_execution_start") open.push(event.toolCallId);
		else if (event.type === "tool_execution_end") {
			// An end with no matching start must not close another running call; checkNoDanglingCall reports it.
			const index = open.lastIndexOf(event.toolCallId);
			if (index !== -1) open.splice(index, 1);
		} else if (event.type === "tool_hook_status" && !topLevel.has(event.toolCallId) && !nested.has(event.toolCallId))
			nested.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, parentId: open.at(-1) });
	}
	return [...nested.values()];
}

export const toolResults = (entries) =>
	messages(entries)
		.filter(({ message }) => message.role === "toolResult")
		.map(({ message }) => message);
