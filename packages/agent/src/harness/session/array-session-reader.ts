import type { SessionEntryCursorOptions, SessionMetadata, SessionReader, SessionTreeEntry } from "../types.ts";
import { SessionError } from "../types.ts";

export function createArraySessionReader<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	readCurrentEntries: () => readonly SessionTreeEntry[],
): SessionReader<TMetadata> {
	let indexedCount = 0;
	let indexedEntries: readonly SessionTreeEntry[] | undefined;
	let leafId: string | null = null;
	const byId = new Map<string, SessionTreeEntry>();

	const updateIndex = (): readonly SessionTreeEntry[] => {
		const entries = readCurrentEntries();
		if (entries !== indexedEntries || entries.length < indexedCount) {
			indexedCount = 0;
			leafId = null;
			byId.clear();
			indexedEntries = entries;
		}
		for (; indexedCount < entries.length; indexedCount++) {
			const entry = entries[indexedCount]!;
			byId.set(entry.id, entry);
			leafId = entry.type === "leaf" ? entry.targetId : entry.id;
		}
		return entries;
	};

	return {
		metadata,
		async readHead() {
			updateIndex();
			if (leafId !== null && !byId.has(leafId)) {
				throw new SessionError("invalid_session", `Entry ${leafId} not found`);
			}
			return { leafId };
		},
		async readEntry(id) {
			updateIndex();
			return byId.get(id);
		},
		async readEntries(options?: SessionEntryCursorOptions) {
			const entries = updateIndex();
			const start = options?.afterEntrySeq ?? 0;
			const end = options?.limit === undefined ? undefined : start + options.limit;
			return entries.slice(start, end);
		},
		async readPathToRootOrCompaction(requestedLeafId) {
			updateIndex();
			if (requestedLeafId === null) return [];
			const path: SessionTreeEntry[] = [];
			let stopAtEntryId: string | null = null;
			let current = byId.get(requestedLeafId);
			if (!current) throw new SessionError("not_found", `Entry ${requestedLeafId} not found`);
			while (current) {
				path.push(current);
				if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
				if (current.type === "compaction") {
					if (current.retainedTail) break;
					stopAtEntryId = current.firstKeptEntryId ?? null;
				}
				if (!current.parentId) break;
				const parent = byId.get(current.parentId);
				if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
				current = parent;
			}
			return path.reverse();
		},
	};
}
