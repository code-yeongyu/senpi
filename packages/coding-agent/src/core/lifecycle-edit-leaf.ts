import type { SessionManager } from "./session-manager.ts";

/** Lifecycle bookkeeping cannot invalidate a caller's optimistic transcript token. */
export function lifecycleEditLeaf(manager: SessionManager, expectedLeafId: string | undefined): string | null {
	const currentLeafId = manager.getLeafId();
	if (expectedLeafId === undefined) return currentLeafId;
	let leafId = currentLeafId;
	while (leafId !== null && leafId !== expectedLeafId) {
		const entry = manager.getEntry(leafId);
		if (
			entry?.type !== "custom" ||
			(entry.customType !== "session-lifecycle" &&
				entry.customType !== "work-custody" &&
				entry.customType !== "child-lifecycle")
		)
			return currentLeafId;
		leafId = entry.parentId;
	}
	return leafId === expectedLeafId ? expectedLeafId : currentLeafId;
}
