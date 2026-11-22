import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionEntry } from "./session-manager.ts";
import { isRecord } from "./work-custody-record.ts";

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

/**
 * The latest run a lifecycle record opened, and whether the transcript holds that run's end (senpi#7016): its last
 * context entry is an assistant answer that asks for no tool call. The agent loop writes that answer before the
 * idle record that clears `runActive`, so a process killed in between (SIGKILL included) leaves the run recorded as
 * active although it ended. A tool call without its result, a tool result, or an input after the answer means work
 * was in flight.
 */
export const lastRunEnd: HistoryReducer<{ runId?: string; ended: boolean }> = {
	initial: () => ({ ended: false }),
	add: (state, entry) => {
		if (entry.type === "custom" && entry.customType === "session-lifecycle") {
			const data = entry.data;
			if (
				isRecord(data) &&
				data.runActive === true &&
				typeof data.runId === "string" &&
				data.runId !== state.runId
			) {
				state.runId = data.runId;
				state.ended = false;
			}
		} else if (entry.type === "message")
			state.ended = entry.message.role === "assistant" && entry.message.stopReason !== "toolUse";
		else if (entry.type === "custom_message") state.ended = false;
		return state;
	},
};
