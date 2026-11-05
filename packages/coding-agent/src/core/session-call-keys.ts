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

/** The toolCall blocks of a message's content, as (content index, id) pairs. */
function toolCallBlocks(content: unknown): readonly (readonly [number, string])[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part: unknown, index) => {
		const id = typeof part === "object" && part !== null ? Reflect.get(part, "id") : undefined;
		return Reflect.get(Object(part), "type") === "toolCall" && typeof id === "string" ? [[index, id] as const] : [];
	});
}

/**
 * The bridge-started calls of the open assistant message (RULING-127 (b)), matched to blocks the way the host's calls
 * table joins them: a top-level `tool_execution_start` first joins the oldest block of its id still waiting for a start;
 * with none, it is bridge-started and mints its call's key with the start. A block then joins the oldest bridge-started
 * call of its id, whether it streams or appears only in the terminal, and the message persists that key on the block,
 * so persisted == live in either order of block and start, and for an id the message reuses.
 */
export class BridgedCallKeys {
	private open = false;
	private seen = new Set<number>();
	private waiting = new Map<string, number>();
	private bridged = new Map<string, string[]>();
	private keyed = new Map<number, string>();

	observe(event: ProducedEvent): void {
		const assistant = event.message?.role === "assistant";
		if (event.type === "message_start" && assistant) {
			this.open = true;
			this.seen = new Set();
			this.waiting = new Map();
			this.bridged = new Map();
			this.keyed = new Map();
		} else if ((event.type === "message_update" || event.type === "message_end") && assistant) {
			for (const [index, id] of toolCallBlocks(event.message?.content)) this.block(index, id);
			if (event.type === "message_end") this.open = false;
		} else if (event.type === "tool_execution_start" && this.open) {
			const id = event.toolCallId;
			if (typeof id !== "string" || event.parentToolCallId !== undefined) return;
			const waiting = this.waiting.get(id) ?? 0;
			if (waiting > 0) return void this.waiting.set(id, waiting - 1);
			const key = `exe:${randomUUID()}`;
			this.bridged.set(id, [...(this.bridged.get(id) ?? []), key]);
			executionKeys.set(event, key);
		}
	}

	/** The ended message's bridge-started calls, content index to key; each message takes them once, at its persistence. */
	take(): ReadonlyMap<number, string> {
		const taken = this.keyed;
		this.keyed = new Map();
		return taken;
	}

	private block(index: number, id: string): void {
		if (this.seen.has(index) || id === "") return;
		this.seen.add(index);
		const [key, ...rest] = this.bridged.get(id) ?? [];
		if (key === undefined) return void this.waiting.set(id, (this.waiting.get(id) ?? 0) + 1);
		this.bridged.set(id, rest);
		this.keyed.set(index, key);
	}
}
