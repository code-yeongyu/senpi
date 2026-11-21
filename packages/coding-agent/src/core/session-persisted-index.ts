import type { FileEntry, SessionEntry } from "./session-manager.ts";

/**
 * Id -> persisted entry of one session file parse, for lookups that miss a trimmed mirror (senpi#2596).
 * A file with duplicated entry ids (#1247) keeps the first occurrence, the one a linear scan finds.
 */
export interface PersistedEntryIndex {
	readonly sessionFile: string;
	readonly byId: ReadonlyMap<string, SessionEntry>;
}

export function indexPersistedEntries(sessionFile: string, entries: readonly FileEntry[]): PersistedEntryIndex {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (entry.type !== "session" && !byId.has(entry.id)) byId.set(entry.id, entry);
	}
	return { sessionFile, byId };
}
