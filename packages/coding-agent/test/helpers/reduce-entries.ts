import type { HistoryReducer } from "../../src/core/session-history-reduce.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

/** `SessionManager.reduceHistory` for a test double whose history is a plain entry list. */
export function reduceEntries<S>(entries: readonly SessionEntry[], reducer: HistoryReducer<S>): S {
	let state = reducer.initial();
	for (const entry of entries) state = reducer.add(state, entry);
	return state;
}
