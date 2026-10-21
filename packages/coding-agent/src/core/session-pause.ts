import type { HistoryReducer } from "./session-history-reduce.ts";

export const SESSION_PAUSE_ENTRY = "session-pause";
export const SESSION_NOTICES_CONSUMED_ENTRY = "session-notices-consumed";

export interface SessionPauseState {
	readonly paused: boolean;
	readonly noticeCount: number;
}

interface PauseHistory {
	paused: boolean;
	noticeIds: string[];
}

/** Session-owned, not branch-owned: navigating the transcript cannot undo a human Stop. */
export const sessionPauseHistory: HistoryReducer<PauseHistory> = {
	initial: () => ({ paused: false, noticeIds: [] }),
	add: (state, entry) => {
		if (entry.type === "custom" && entry.customType === SESSION_PAUSE_ENTRY) {
			const data: unknown = entry.data;
			if (typeof data === "object" && data !== null && "paused" in data && typeof data.paused === "boolean") {
				state.paused = data.paused;
			}
		} else if (entry.type === "custom" && entry.customType === SESSION_NOTICES_CONSUMED_ENTRY) {
			const data = entry.data as { entryIds?: unknown } | undefined;
			if (Array.isArray(data?.entryIds)) {
				const consumed = new Set(data.entryIds);
				state.noticeIds = state.noticeIds.filter((id) => !consumed.has(id));
			}
		} else if (state.paused && entry.type === "custom_message") {
			state.noticeIds.push(entry.id);
		}
		return state;
	},
};
