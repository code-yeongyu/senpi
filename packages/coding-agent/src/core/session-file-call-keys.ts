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
	Reflect.deleteProperty(entry, "runtimeItemKey");
	Reflect.deleteProperty(entry, "callUnknown");
	if (unknown) return { result: { callUnknown: true } };
	return typeof key === "string" ? { result: { runtimeItemKey: key } } : undefined;
}

/**
 * The out-of-band call keys of one session file (RULING-126/127, senpi#5374). The file holds `runtimeItemKey` on each
 * toolCall part and `runtimeItemKey` or `callUnknown: true` on a toolResult entry; memory never does, so every legacy
 * and flag-off reader keeps its bytes. Loading strips them into this table, keyed by entry id, and every write of an
 * entry (append, rewrite, migration, branch) puts them back. An old session's parts get load-time keys instead, minted
 * on first read and never written: stable for this load only.
 */
export class SessionFileCallKeys {
	private readonly byEntry = new Map<string, EntryCallKeys>();
	private readonly loadTime = new Map<string, string>();

	clear(): void {
		this.byEntry.clear();
		this.loadTime.clear();
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

	/** A new assistant entry: each toolCall part keyed by its block (`owner` is the message's recovery id) or its bridge. */
	recordAssistant(entry: MessageEntry, owner: string | undefined, bridged: ReadonlyMap<string, string> = new Map()) {
		const prefix = owner ?? randomUUID();
		const taken = new Set<string>();
		const parts = partsOf(entry).map((part, index) => {
			if (part.type !== "toolCall") return undefined;
			const bridge = typeof part.id === "string" && !taken.has(part.id) ? bridged.get(part.id) : undefined;
			if (bridge !== undefined && typeof part.id === "string") taken.add(part.id);
			return bridge ?? blockCallKey(prefix, index);
		});
		if (parts.some((key) => key !== undefined)) this.byEntry.set(entry.id, { parts });
	}

	/**
	 * A new toolResult entry (RULING-126 (2)) appended under `leafId`: keyed only when its id names exactly one toolCall
	 * part of the latest assistant entry on the branch that no result after it closed, and whose key is persisted. A
	 * same-message reused id is `callUnknown`, never an order-picked key; a load-time key is never written onto a result.
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
		if (!assistant || id === undefined) return;
		const matches = partsOf(assistant).flatMap((part, index) =>
			part.type === "toolCall" && part.id === id ? [index] : [],
		);
		if (matches.length > 1) return void this.byEntry.set(entry.id, { result: { callUnknown: true } });
		const key =
			matches.length === 1 && !closed.has(id)
				? this.byEntry.get(assistant.id)?.parts?.[matches[0] ?? -1]
				: undefined;
		if (key !== undefined) this.byEntry.set(entry.id, { result: { runtimeItemKey: key } });
	}

	/** The key of `entry`'s toolCall part at `index`: persisted when the file holds one, else this load's load-time key. */
	keyOf(entry: SessionEntry, index: number): string | undefined {
		if (partsOf(entry)[index]?.type !== "toolCall") return undefined;
		const persisted = this.byEntry.get(entry.id)?.parts?.[index];
		if (persisted !== undefined) return persisted;
		const slot = `${entry.id}:${index}`;
		const minted = this.loadTime.get(slot) ?? blockCallKey(randomUUID(), index);
		this.loadTime.set(slot, minted);
		return minted;
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
