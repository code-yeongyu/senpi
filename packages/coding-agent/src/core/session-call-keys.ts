import { randomUUID } from "node:crypto";

/**
 * The call key a session persists and a compact peer reads (RULING-126/127, senpi#5374), minted by the producer:
 * - `blk:<messageId>:<contentIndex>` for a toolCall block. `messageId` is the message's recovery id when the session
 *   has one, so the host's calls table derives the same key from the block's address with nothing on the wire.
 * - `exe:<uuid>` for a bridge-started call (its execution started before its block streamed), minted with that start
 *   and carried to the host out of band, so the first key the call carries stays its key when the block joins.
 * The host mints `<sessionEpoch>:<sequence>.<k>` only for a call with no backing block (a nested call).
 */
export function blockCallKey(messageId: string, contentIndex: number): string {
	return `blk:${messageId}:${contentIndex}`;
}

const executionKeys = new WeakMap<object, string>();

/** The key a bridge-started call's `tool_execution_start` carries out of band: never a field of the record. */
export function executionCallKey(record: object): string | undefined {
	return executionKeys.get(record);
}

/** A copy of a record on its way to the host keeps the original's execution key (`carryRecovery`). */
export function carryExecutionCallKey(from: object, to: object): void {
	const key = executionKeys.get(from);
	if (key !== undefined && from !== to) executionKeys.set(to, key);
}

interface ProducedEvent {
	readonly type: string;
	readonly message?: { readonly role?: unknown; readonly content?: unknown };
	readonly toolCallId?: unknown;
	readonly parentToolCallId?: unknown;
}

function streamedIds(content: unknown): readonly string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part: unknown) => {
		const id = typeof part === "object" && part !== null ? Reflect.get(part, "id") : undefined;
		return Reflect.get(Object(part), "type") === "toolCall" && typeof id === "string" ? [id] : [];
	});
}

/**
 * The bridge-started calls of the open assistant message (RULING-127 (b)): a top-level `tool_execution_start` whose id
 * no block of that message has streamed yet mints its call's key with the start. The message persists that key on the
 * block that later joins the call, so persisted == live in either order of block and start.
 */
export class BridgedCallKeys {
	private open = false;
	private streamed = new Set<string>();
	private pending = new Map<string, string>();

	observe(event: ProducedEvent): void {
		const assistant = event.message?.role === "assistant";
		if (event.type === "message_start" && assistant) {
			this.open = true;
			this.streamed = new Set();
			this.pending = new Map();
		} else if (event.type === "message_update" && assistant) {
			for (const id of streamedIds(event.message?.content)) this.streamed.add(id);
		} else if (event.type === "message_end" && assistant) {
			this.open = false;
		} else if (event.type === "tool_execution_start" && this.open) {
			const id = event.toolCallId;
			if (typeof id !== "string" || event.parentToolCallId !== undefined) return;
			if (this.streamed.has(id) || this.pending.has(id)) return;
			const key = `exe:${randomUUID()}`;
			this.pending.set(id, key);
			executionKeys.set(event, key);
		}
	}

	/** The ended message's bridge-started calls, toolCallId to key; each message takes them once, at its persistence. */
	take(): ReadonlyMap<string, string> {
		const taken = this.pending;
		this.pending = new Map();
		return taken;
	}
}
