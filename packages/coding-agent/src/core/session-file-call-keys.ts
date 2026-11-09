import { randomUUID } from "node:crypto";
import { blockCallKey } from "./session-call-keys.ts";
import type { FileEntry, SessionEntry } from "./session-manager.ts";

/** A toolResult entry's call (RULING-126 (2)): the key of the one open call it maps to, or a same-message reused id. */
type ResultCallMark = { readonly runtimeItemKey: string } | { readonly callUnknown: true };

interface EntryCallKeys {
	/** Part keys by content index, as the file holds them. */
	readonly parts?: readonly (string | undefined)[];
	readonly result?: ResultCallMark;
}

type Part = { readonly type?: unknown; readonly id?: unknown; readonly runtimeItemKey?: unknown };
type MessageEntry = Extract<FileEntry, { type: "message" }>;

const roleOf = (entry: FileEntry) => (entry.type === "message" ? entry.message.role : undefined);
const partsOf = (entry: FileEntry): readonly Part[] => {
	const content: unknown = entry.type === "message" ? Reflect.get(entry.message, "content") : undefined;
	return Array.isArray(content) ? content : [];
};

/** The persisted call fields a parsed entry held, taken out of it in place (RULING-127 (c)). */
function takeKeys(entry: FileEntry): EntryCallKeys | undefined {
	const role = roleOf(entry);
	if (role === "assistant") {
		const parts = partsOf(entry).map((part) =>
			typeof part.runtimeItemKey === "string" ? part.runtimeItemKey : undefined,
		);
		if (!parts.some((key) => key !== undefined)) return undefined;
		for (const part of partsOf(entry))
			if (typeof part === "object" && part !== null) Reflect.deleteProperty(part, "runtimeItemKey");
		return { parts };
	}
	if (role !== "toolResult") return undefined;
	const key = Reflect.get(entry, "runtimeItemKey");
	const unknown = Reflect.get(entry, "callUnknown") === true;
	if (key !== undefined) Reflect.deleteProperty(entry, "runtimeItemKey");
	if (unknown) Reflect.deleteProperty(entry, "callUnknown");
	if (unknown) return { result: { callUnknown: true } };
	return typeof key === "string" ? { result: { runtimeItemKey: key } } : undefined;
}

/**
 * The out-of-band call keys of one session file (RULING-126/127, senpi#5374). The file holds `runtimeItemKey` on each
 * toolCall part and `runtimeItemKey` or `callUnknown: true` on a toolResult entry; memory never does, so every legacy
 * and flag-off reader keeps its bytes. Loading strips them into this table, keyed by entry id, and every write of an
 * entry (append, rewrite, migration, branch, export) puts them back. An old session's parts have no key, and nothing
 * mints one at load: no reader rebuilds a call from a loaded part, so a key that is not persisted would have no reader.
 */
export class SessionFileCallKeys {
	private readonly byEntry = new Map<string, EntryCallKeys>();

	clear(): void {
		this.byEntry.clear();
	}

	adopt(entries: readonly FileEntry[]): void {
		for (const entry of entries) {
			const keys = takeKeys(entry);
			if (keys && "id" in entry) this.byEntry.set(entry.id, keys);
		}
	}

	/** An entry read again from the file (an evicted string's recovery): the table already holds its keys. */
	strip<T extends FileEntry>(entry: T): T {
		takeKeys(entry);
		return entry;
	}

	/**
	 * A new assistant entry: each toolCall part keyed by its block (`owner` is the message's recovery id), or by the
	 * key its bridge-started call carried (`bridged`, by content index).
	 */
	recordAssistant(entry: MessageEntry, owner: string | undefined, bridged: ReadonlyMap<number, string> = new Map()) {
		const prefix = owner ?? randomUUID();
		const parts = partsOf(entry).map((part, index) =>
			part.type === "toolCall" ? (bridged.get(index) ?? blockCallKey(prefix, index)) : undefined,
		);
		if (parts.some((key) => key !== undefined)) this.byEntry.set(entry.id, { parts });
	}

	/**
	 * A new toolResult entry (RULING-126 (2)) appended under `leafId`: keyed only when its id names exactly one toolCall
	 * part of the latest assistant entry on the branch that no result after it closed, and whose key is persisted. Every
	 * other result (a same-message reused id, a closed call, a call with no keyed part) is `callUnknown`: the entry says
	 * it cannot vouch for a call, never names an order-picked one, and never carries neither field.
	 */
	recordResult(entry: MessageEntry, leafId: string | null, entryOf: (id: string) => SessionEntry | undefined): void {
		const id = entry.message.role === "toolResult" ? entry.message.toolCallId : undefined;
		const closed = new Set<string>();
		let assistant: SessionEntry | undefined;
		for (
			let at = entryOf(leafId ?? "");
			at && !assistant;
			at = at.parentId === null ? undefined : entryOf(at.parentId)
		) {
			if (roleOf(at) === "assistant") assistant = at;
			else if (at.type === "message" && at.message.role === "toolResult") closed.add(at.message.toolCallId);
		}
		const matches = assistant
			? partsOf(assistant).flatMap((part, index) => (part.type === "toolCall" && part.id === id ? [index] : []))
			: [];
		const open = id !== undefined && matches.length === 1 && !closed.has(id);
		const key = assistant && open ? this.byEntry.get(assistant.id)?.parts?.[matches[0] ?? -1] : undefined;
		this.byEntry.set(entry.id, { result: key === undefined ? { callUnknown: true } : { runtimeItemKey: key } });
	}

	/** The entry as the file holds it: its persisted keys back in place, after every other field. */
	decorate(entry: FileEntry): FileEntry {
		const keys = "id" in entry ? this.byEntry.get(entry.id) : undefined;
		if (!keys || entry.type !== "message") return entry;
		if (keys.result) return { ...entry, ...keys.result };
		const content = partsOf(entry).map((part, index) => {
			const key = keys.parts?.[index];
			return key === undefined ? part : { ...part, runtimeItemKey: key };
		});
		return { ...entry, message: { ...entry.message, content } } as FileEntry;
	}
}
