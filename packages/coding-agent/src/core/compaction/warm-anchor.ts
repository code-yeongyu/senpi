import type { SessionEntry } from "../session-manager.ts";

export interface WarmAnchorSnapshot {
	firstKeptEntryId: string;
	prefixEntryIds: readonly string[];
	latestCompactionEntryId: string | null;
}

function latestCompactionEntryId(entries: readonly SessionEntry[]): string | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "compaction") return entry.id;
	}
	return null;
}

export function createWarmAnchorSnapshot(
	firstKeptEntryId: string,
	branchEntries: readonly SessionEntry[],
): WarmAnchorSnapshot | undefined {
	const anchorIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (anchorIndex === -1) return undefined;
	return {
		firstKeptEntryId,
		prefixEntryIds: branchEntries.slice(0, anchorIndex).map((entry) => entry.id),
		latestCompactionEntryId: latestCompactionEntryId(branchEntries),
	};
}

/**
 * A warm summary describes the entries before its cut point, so growth after that
 * cut - idle wait notices, monitor state, and the user's next prompt - leaves it
 * accurate. Validity is therefore a property of the summarized prefix, not of a
 * monotonic message revision, which counts appends the summary never covered.
 *
 * The compaction boundary is compared by IDENTITY rather than array position:
 * compaction records are appended after the entries they summarize, so a valid
 * next-generation anchor routinely precedes the boundary it updates, and two
 * sibling branches can carry different boundaries at the same index.
 */
export function isWarmSummaryAnchorValid(
	snapshot: WarmAnchorSnapshot,
	currentBranchEntries: readonly SessionEntry[],
): boolean {
	const anchorIndex = currentBranchEntries.findIndex((entry) => entry.id === snapshot.firstKeptEntryId);
	if (anchorIndex === -1) return false;
	if (latestCompactionEntryId(currentBranchEntries) !== snapshot.latestCompactionEntryId) return false;
	if (anchorIndex !== snapshot.prefixEntryIds.length) return false;
	for (let index = 0; index < anchorIndex; index++) {
		if (currentBranchEntries[index]?.id !== snapshot.prefixEntryIds[index]) return false;
	}
	return true;
}
