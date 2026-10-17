import type { CompactionEntry, FileEntry, SessionEntry } from "./session-manager.ts";

/**
 * The part of a loaded session file the resident mirror keeps (senpi#3519).
 *
 * A reopened session needs only what its context is built from: the latest compaction on the
 * leaf's branch and everything from that compaction's first kept entry on. The entries before it
 * stay in the session file, where full-history readers (`getEntries`, `getTree`, `getEntry`,
 * branching to an old entry) already reload them, exactly as they do after a live compaction.
 */
export interface LoadedTail {
	/** The header, the non-message entries of the leaf's path before the kept window, and the window itself. */
	readonly retained: FileEntry[];
	/** Ids of the entries the mirror leaves out; a new entry must never reuse one. */
	readonly trimmedIds: readonly string[];
}

/**
 * Returns the retained tail of `entries` as loaded from a session file, or undefined when the whole
 * file has to stay resident: no compaction on the leaf's branch, duplicated ids, a first kept entry
 * that is not on the leaf's branch, or an entry from the kept window on that branch whose parent is
 * outside it (a branch forked from before the window), which a trimmed mirror could not link.
 *
 * Retained entries are shallow copies: the prefix is relinked into one chain and the window's root
 * entries hang off its end, as `_trimMirrorAfterCompaction` links them after a live compaction.
 */
export function planLoadedTail(entries: readonly FileEntry[]): LoadedTail | undefined {
	const byId = new Map<string, SessionEntry>();
	let leaf: SessionEntry | undefined;
	for (const entry of entries) {
		if (entry.type === "session") continue;
		if (byId.has(entry.id)) return undefined;
		byId.set(entry.id, entry);
		leaf = entry;
	}
	const path = leafPath(leaf, byId);
	const compaction = path.find((entry): entry is CompactionEntry => entry.type === "compaction");
	if (compaction === undefined) return undefined;
	const pathIds = new Set(path.map((entry) => entry.id));
	if (!pathIds.has(compaction.firstKeptEntryId)) return undefined;
	const firstKeptIndex = entries.findIndex(
		(entry) => entry.type !== "session" && entry.id === compaction.firstKeptEntryId,
	);
	const firstKept = entries[firstKeptIndex];
	if (firstKept === undefined || firstKept.type === "session") return undefined;
	const boundaryParent = firstKept.parentId;

	const window = entries.slice(firstKeptIndex).filter((entry): entry is SessionEntry => entry.type !== "session");
	const windowIds = new Set(window.map((entry) => entry.id));
	for (const entry of window) {
		if (entry.parentId !== null && entry.parentId !== boundaryParent && !windowIds.has(entry.parentId))
			return undefined;
	}

	const header = entries.find((entry) => entry.type === "session");
	const prefix = entries
		.slice(0, firstKeptIndex)
		.filter((entry): entry is SessionEntry => entry.type !== "session" && keepsBeforeWindow(entry, pathIds));
	const retained: FileEntry[] = header === undefined ? [] : [header];
	let parentId: string | null = null;
	for (const entry of prefix) {
		retained.push({ ...entry, parentId });
		parentId = entry.id;
	}
	for (const entry of window) {
		retained.push(entry.parentId === boundaryParent ? { ...entry, parentId } : entry);
	}

	const retainedIds = new Set([...prefix, ...window].map((entry) => entry.id));
	const trimmedIds = [...byId.keys()].filter((id) => !retainedIds.has(id));
	return trimmedIds.length === 0 ? undefined : { retained, trimmedIds };
}

/**
 * Before the window, the mirror keeps the leaf path's non-message entries (model and thinking
 * changes, earlier compactions, custom state) and every label and session name, which describe
 * the whole session rather than one branch.
 */
function keepsBeforeWindow(entry: SessionEntry, pathIds: ReadonlySet<string>): boolean {
	if (entry.type === "label" || entry.type === "session_info") return true;
	return entry.type !== "message" && pathIds.has(entry.id);
}

function leafPath(leaf: SessionEntry | undefined, byId: ReadonlyMap<string, SessionEntry>): SessionEntry[] {
	const path: SessionEntry[] = [];
	const visited = new Set<string>();
	let current = leaf;
	while (current !== undefined && !visited.has(current.id)) {
		visited.add(current.id);
		path.push(current);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return path;
}
