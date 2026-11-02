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
 * - Type-gate the media walk. JSON-value normalization is shared with writer
 *   acceptance; media projection itself never walks `message_update` partials.
 * - Copy-on-write. Responses hand out live agent state by reference
 *   (`success(id, "get_messages", { messages: session.messages })`), so the input graph
 *   is never mutated and unchanged JSON sub-trees keep their identity. When nothing changed
 *   the SAME record reference comes back, which lets the caller reuse the line it
 *   already serialized.
 *
 * User-authored images (`prompt.images`) stay intact: they are bounded by the client
 * that sent them; the fan-out hazard is tool output.
 */

import { normalizeJsonValue } from "./json-normal-value.ts";

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

/** Why a host could not keep a tool image on disk for the client to read. */
export type MediaUnavailableReason = "image_too_large" | "session_limit" | "storage_error";

/** Where a persisted image lives (absolute), or why there is no file. */
export type PersistedMedia = { readonly path: string } | { readonly unavailableReason: MediaUnavailableReason };

/**
 * Writes one image's bytes to the session's media directory and reports the outcome. Returns
 * `undefined` for a session that has nowhere durable to keep them: its placeholder carries neither field.
 */
export type MediaPersister = (
	ref: { readonly toolCallId: string; readonly contentIndex: number },
	block: { readonly data: string; readonly mimeType?: string },
) => PersistedMedia | undefined;

/** The block a capable client receives in place of inline image bytes. */
export interface ImageRefBlock {
	readonly type: "image_ref";
	readonly mimeType: string;
	readonly byteLength: number;
	readonly ref: { readonly toolCallId: string; readonly contentIndex: number };
	/** Absolute path of the stored bytes; written before this placeholder was emitted. */
	readonly path?: string;
	readonly unavailableReason?: MediaUnavailableReason;
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
function omitContentImages(
	content: readonly unknown[],
	toolCallId: string,
	persist: MediaPersister | undefined,
): readonly unknown[] {
	let replaced: unknown[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const block = content[index];
		if (!isInlineImage(block)) continue;
		replaced ??= [...content];
		const ref = { toolCallId, contentIndex: index };
		// The bytes reach disk before the placeholder that names them leaves this function.
		replaced[index] = {
			type: "image_ref",
			mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
			byteLength: base64ByteLength(block.data),
			ref,
			...persist?.(ref, block),
		} satisfies ImageRefBlock;
	}
	return replaced ?? content;
}

/** A toolResult message whose content array carries images, rebuilt without them. */
function omitToolResultImages(message: RpcRecord, persist: MediaPersister | undefined): RpcRecord {
	const content = message.content;
	const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
	if (!Array.isArray(content)) return message;
	const omitted = omitContentImages(content, toolCallId, persist);
	return omitted === content ? message : { ...message, content: omitted };
}

/** One container on the walk's explicit stack; `key` is where its result goes in the parent. */
type WalkFrame =
	| { readonly key: string | number; readonly value: unknown[]; index: number; replaced?: unknown[] }
	| {
			readonly key: string | number;
			readonly value: RpcRecord;
			readonly scrubbed: RpcRecord;
			readonly entries: readonly (readonly [string, unknown])[];
			index: number;
			replaced?: RpcRecord;
	  };

/** Enter a container (scrubbing a toolResult on entry, so persister calls stay in pre-order), or undefined for a leaf. */
function enter(value: unknown, key: string | number, persist: MediaPersister | undefined): WalkFrame | undefined {
	if (Array.isArray(value)) return { key, value, index: 0 };
	if (!isPlainObject(value)) return undefined;
	const scrubbed = value.role === "toolResult" ? omitToolResultImages(value, persist) : value;
	const entries = Object.entries(scrubbed).filter(
		([name, child]) => (name !== "content" || scrubbed === value) && (isPlainObject(child) || Array.isArray(child)),
	);
	return scrubbed === value
		? { key, value, scrubbed, entries, index: 0 }
		: { key, value, scrubbed, entries, index: 0, replaced: { ...scrubbed } };
}

/**
 * Copy-on-write walk. Every object with `role:"toolResult"` has its content array
 * scrubbed, wherever it sits (message arrays, `turn_end.toolResults`, session entries,
 * tree nodes, `state.entries`). Unchanged sub-trees are returned by reference.
 *
 * The walk keeps its own stack instead of recursing, so a record of any depth the JSON engine can serialize passes
 * (a recursive walk overflowed from about 3,000 levels on Node, below the engine's ~6,185; senpi#4272 RULING-68).
 * A cycle is refused as native JSON refuses it.
 */
function walk(root: unknown, persist: MediaPersister | undefined): unknown {
	const first = enter(root, 0, persist);
	if (!first) return root;
	const stack: WalkFrame[] = [first];
	const ancestors = new Set<object>([first.value]);
	for (;;) {
		const top = stack[stack.length - 1] as WalkFrame;
		if ("entries" in top ? top.index < top.entries.length : top.index < top.value.length) {
			const [key, child] =
				"entries" in top
					? (top.entries[top.index] as readonly [string, unknown])
					: [top.index, top.value[top.index]];
			top.index++;
			const frame = enter(child, key, persist);
			if (!frame) continue;
			if (ancestors.has(frame.value)) throw new TypeError("Converting circular structure to JSON");
			ancestors.add(frame.value);
			stack.push(frame);
			continue;
		}
		stack.pop();
		ancestors.delete(top.value);
		const result = top.replaced ?? top.value;
		const parent = stack[stack.length - 1];
		if (!parent) return result;
		if (result === top.value) continue;
		if ("entries" in parent) (parent.replaced ??= { ...parent.scrubbed })[top.key] = result;
		else (parent.replaced ??= [...parent.value])[top.key as number] = result;
	}
}

/** `tool_execution_end.result.content` is not a toolResult message; scrub it explicitly. */
function omitToolExecutionEndImages(record: RpcRecord, persist: MediaPersister | undefined): RpcRecord {
	const result = record.result;
	if (!isPlainObject(result) || !Array.isArray(result.content)) return record;
	const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
	const omitted = omitContentImages(result.content, toolCallId, persist);
	return omitted === result.content ? record : { ...record, result: { ...result, content: omitted } };
}

/** True when this record type can carry a tool result at all (cheap gate). */
export function carriesMedia(record: RpcRecord): boolean {
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
export function omitInlineMedia<T extends object>(record: T, persist?: MediaPersister): T {
	const { value, changed } = normalizeJsonValue(record);
	if (!changed) return omitNormalInlineMedia(record, persist);
	return omitNormalInlineMedia(value as T, persist);
}

/** `omitInlineMedia` for a value that is already JSON-normal: type gate first, no normalization walk. */
export function omitNormalInlineMedia<T extends object>(record: T, persist?: MediaPersister): T {
	const typed = record as unknown as RpcRecord;
	if (!carriesMedia(typed)) return record;
	const scrubbed = typed.type === "tool_execution_end" ? omitToolExecutionEndImages(typed, persist) : typed;
	const walked = walk(scrubbed, persist);
	return (walked === typed ? record : walked) as T;
}
