/** Record-compaction primitives of the shared stdio lane (moved verbatim from session-event-writer.ts). */
export type RpcRecord = Record<string, unknown>;
export type CompactDeltaType = "text_delta" | "thinking_delta" | "toolcall_delta";
export const MESSAGE_KEY = "message";
export const COMPACT_DELTA_TYPES = new Set<CompactDeltaType>(["text_delta", "thinking_delta", "toolcall_delta"]);

export function compactDelta(
	value: RpcRecord,
): { type: CompactDeltaType; contentIndex: number; delta: string } | undefined {
	if (value.type !== "message_update" || !Object.hasOwn(value, "message")) return undefined;
	const event = value.assistantMessageEvent;
	if (typeof event !== "object" || event === null) return undefined;
	const typedEvent = event as Record<string, unknown>;
	if (
		typeof typedEvent.type !== "string" ||
		!COMPACT_DELTA_TYPES.has(typedEvent.type as CompactDeltaType) ||
		typeof typedEvent.contentIndex !== "number" ||
		typeof typedEvent.delta !== "string"
	) {
		return undefined;
	}
	return {
		type: typedEvent.type as CompactDeltaType,
		contentIndex: typedEvent.contentIndex,
		delta: typedEvent.delta,
	};
}

/** The delta-only form of a compact message_update: cumulative snapshot fields blanked, delta kept. */
export function demoteToDeltaOnly(value: RpcRecord): RpcRecord {
	const event = value.assistantMessageEvent as Record<string, unknown>;
	return { ...value, message: null, assistantMessageEvent: { ...event, partial: null } };
}

export function toolUpdateKey(value: RpcRecord): string | undefined {
	return value.type === "tool_execution_update" && typeof value.toolCallId === "string"
		? `tool:${value.toolCallId}`
		: undefined;
}
