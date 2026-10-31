import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionEntry } from "./session-manager.ts";

/** Lifecycle restoration needs bookkeeping, not a retained full conversation view. */
export const lifecycleHistory: HistoryReducer<SessionEntry[]> = {
	initial: () => [],
	add: (entries, entry) => {
		if (
			entry.type === "custom" &&
			(entry.customType === "session-lifecycle" ||
				entry.customType === "work-custody" ||
				entry.customType === "child-lifecycle" ||
				entry.customType === "interrupted-run")
		)
			entries.push(entry);
		return entries;
	},
};
