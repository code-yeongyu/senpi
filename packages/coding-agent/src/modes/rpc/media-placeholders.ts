/**
 * The `media_placeholders` transform (one choke point, not five).
 *
 * A client that advertised `MEDIA_PLACEHOLDERS_CAPABILITY` must never receive
 * `{type:"image", data:<base64>}` inside a tool result — four inline images once
 * overflowed a 4 MiB socket queue and froze the desktop. Rather than patching each
 * wire path that can carry a tool result (`message_start`/`message_end`,
 * `turn_end.toolResults`, `agent_end`, `entry_appended`, and the `get_messages`,
 * `get_entries`, `get_tree`, `get_state`, `open_session` responses — a list that has
 * already been wrong once), every record is funnelled through this pure transform at
 * `SessionEventWriter.enqueue`.
 *
 * Two hard rules:
 * - Type-gate FIRST. `message_update` is the hot path (one record per token) and must
 *   never be walked.
 * - Copy-on-write. Responses hand out live agent state by reference
 *   (`success(id, "get_messages", { messages: session.messages })`), so the input graph
 *   is never mutated and unchanged sub-trees keep their identity. When nothing changed
 *   the SAME record reference comes back, which lets the caller reuse the line it
 *   already serialized.
 *
 * User-authored images (`prompt.images`) stay intact: they are bounded by the client
 * that sent them; the fan-out hazard is tool output.
 */

type RpcRecord = Record<string, unknown>;

/** Record types that can carry a tool result somewhere in their payload. */
const MEDIA_BEARING_RECORD_TYPES = new Set([
	"tool_execution_end",
	"message_start",
	"message_end",
	"turn_end",
	"agent_end",
	"entry_appended",
]);

/** Response commands whose payload can carry a tool result. */
const MEDIA_BEARING_RESPONSE_COMMANDS = new Set([
	"get_messages",
	"get_entries",
	"get_tree",
	"get_state",
	"open_session",
]);

/** The block a capable client receives in place of inline image bytes. */
export interface ImageRefBlock {
	readonly type: "image_ref";
	readonly mimeType: string;
	readonly byteLength: number;
	readonly ref: { readonly toolCallId: string; readonly contentIndex: number };
}

/**
 * Decoded byte length of a base64 string, derived from its length alone.
 *
 * Decoding a multi-MiB payload just to report its size would defeat the purpose of
 * omitting it.
 */
export function base64ByteLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function isPlainObject(value: unknown): value is RpcRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInlineImage(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	return isPlainObject(value) && value.type === "image" && typeof value.data === "string";
}

/** Replace inline images in one tool-result content array; same reference when none. */
function omitContentImages(content: readonly unknown[], toolCallId: string): readonly unknown[] {
	let replaced: unknown[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const block = content[index];
		if (!isInlineImage(block)) continue;
		replaced ??= [...content];
		replaced[index] = {
			type: "image_ref",
			mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
			byteLength: base64ByteLength(block.data),
			ref: { toolCallId, contentIndex: index },
		} satisfies ImageRefBlock;
	}
	return replaced ?? content;
}

/** A toolResult message whose content array carries images, rebuilt without them. */
function omitToolResultImages(message: RpcRecord): RpcRecord {
	const content = message.content;
	const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
	if (!Array.isArray(content)) return message;
	const omitted = omitContentImages(content, toolCallId);
	return omitted === content ? message : { ...message, content: omitted };
}

/**
 * Copy-on-write walk. Every object with `role:"toolResult"` has its content array
 * scrubbed, wherever it sits (message arrays, `turn_end.toolResults`, session entries,
 * tree nodes, `state.entries`). Unchanged sub-trees are returned by reference.
 */
function walk(value: unknown): unknown {
	if (Array.isArray(value)) {
		let replaced: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const next = walk(value[index]);
			if (next === value[index]) continue;
			replaced ??= [...value];
			replaced[index] = next;
		}
		return replaced ?? value;
	}
	if (!isPlainObject(value)) return value;

	const scrubbed = value.role === "toolResult" ? omitToolResultImages(value) : value;
	let replaced: RpcRecord | undefined = scrubbed === value ? undefined : { ...scrubbed };
	for (const [key, child] of Object.entries(scrubbed)) {
		if (key === "content" && scrubbed !== value) continue;
		if (!isPlainObject(child) && !Array.isArray(child)) continue;
		const next = walk(child);
		if (next === child) continue;
		replaced ??= { ...scrubbed };
		replaced[key] = next;
	}
	return replaced ?? value;
}

/** `tool_execution_end.result.content` is not a toolResult message; scrub it explicitly. */
function omitToolExecutionEndImages(record: RpcRecord): RpcRecord {
	const result = record.result;
	if (!isPlainObject(result) || !Array.isArray(result.content)) return record;
	const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
	const omitted = omitContentImages(result.content, toolCallId);
	return omitted === result.content ? record : { ...record, result: { ...result, content: omitted } };
}

/** True when this record type can carry a tool result at all (cheap gate). */
function carriesMedia(record: RpcRecord): boolean {
	if (typeof record.type !== "string") return false;
	if (MEDIA_BEARING_RECORD_TYPES.has(record.type)) return true;
	return record.type === "response" && typeof record.command === "string"
		? MEDIA_BEARING_RESPONSE_COMMANDS.has(record.command)
		: false;
}

/**
 * Replace inline tool-result images with `image_ref` placeholders.
 *
 * Returns the SAME reference when nothing changed, so the caller can skip the second
 * serialization entirely.
 */
export function omitInlineMedia<T extends object>(record: T): T {
	const typed = record as unknown as RpcRecord;
	if (!carriesMedia(typed)) return record;
	const scrubbed = typed.type === "tool_execution_end" ? omitToolExecutionEndImages(typed) : typed;
	const walked = walk(scrubbed);
	return (walked === typed ? record : walked) as T;
}
