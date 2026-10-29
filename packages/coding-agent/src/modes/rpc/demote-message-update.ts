/**
 * Release a superseded cumulative snapshot, not its delta or its position in the stream.
 * This is the same delta-only representation the socket/stdout queues already deliver.
 * Never mutate the source: live listeners may still be using the original event.
 */
export function demoteMessageUpdate(value: object): object {
	if (!("type" in value) || value.type !== "message_update" || !("assistantMessageEvent" in value)) return value;
	const event = value.assistantMessageEvent;
	if (typeof event !== "object" || event === null) return value;
	if (!("partial" in event) && !("message" in value)) return value;
	let toolSeed: { id: string; toolName: string } | undefined;
	if ("type" in event && event.type === "toolcall_start" && "contentIndex" in event) {
		const partial = "partial" in event ? event.partial : "message" in value ? value.message : undefined;
		if (typeof partial === "object" && partial !== null && "content" in partial && Array.isArray(partial.content)) {
			const block = partial.content[Number(event.contentIndex)];
			if (block?.type === "toolCall") toolSeed = { id: block.id, toolName: block.name };
		}
	}
	return {
		...value,
		...("message" in value ? { message: null } : {}),
		assistantMessageEvent: { ...event, ...toolSeed, ...("partial" in event ? { partial: null } : {}) },
	};
}
