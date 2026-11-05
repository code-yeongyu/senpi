import { CALL_UNKNOWN, type CallIdentity } from "./compact-call-model.ts";

/** RULING-123 (#5346): the execution and hook records whose compact copy names the call they belong to. */
export const CALL_NAMED_RECORDS: ReadonlySet<string> = new Set([
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"tool_hook_status",
]);

const streamEvent = (record: object): object => Object(Reflect.get(record, "assistantMessageEvent"));

/** A `toolcall_start`, `toolcall_delta` or `toolcall_end` update: it streams one call's block of its message. */
function streamsCall(record: object): boolean {
	const kind: unknown = Reflect.get(streamEvent(record), "type");
	return Reflect.get(record, "type") === "message_update" && typeof kind === "string" && kind.startsWith("toolcall_");
}

/** The content index of the block a `toolcall_*` update streams; undefined for every other record. */
export function toolcallIndex(record: object): number | undefined {
	const index: unknown = Reflect.get(streamEvent(record), "contentIndex");
	return streamsCall(record) && typeof index === "number" ? index : undefined;
}

/**
 * What a compact peer's copy of `record` says when the lane holds no identity for it. A live call record the host
 * changed no call with (ignored as unknown or late, refused at the protocol depth limit, or arriving while the compact
 * state is unavailable) says `callUnknown` rather than omitting the key (RULING-123 (7), RULING-122's fail-safe rule);
 * every other record says nothing.
 */
export function unvouchedCall(record: object): CallIdentity | undefined {
	const named = CALL_NAMED_RECORDS.has(String(Reflect.get(record, "type")));
	return named || streamsCall(record) ? CALL_UNKNOWN : undefined;
}
