import { isLifecycleBookkeeping } from "./lifecycle-bookkeeping.ts";
import { readLifecycleRecord } from "./lifecycle-record.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionEntry } from "./session-manager.ts";
import { isRecord, readWorkCustody } from "./work-custody-record.ts";

/** Where each folded record sits in a `lifecycleHistory` state, so a newer record replaces it in place. */
const foldedSlots = new WeakMap<SessionEntry[], Map<string, { index: number; seq: number | undefined }>>();

/**
 * The slot a bookkeeping entry folds into, or undefined for an entry that is kept as written. A
 * `session-lifecycle` slot carries its record's `seq`: restoration takes the highest of a session. A
 * `work-custody` slot carries none: restoration takes the last record of a record id.
 */
function foldSlot(entry: SessionEntry): { key: string; seq: number | undefined } | undefined {
	if (entry.type !== "custom") return undefined;
	if (entry.customType === "session-lifecycle") {
		const record = readLifecycleRecord(entry.data);
		return record ? { key: `lifecycle:${record.sessionId}`, seq: record.seq } : undefined;
	}
	if (entry.customType === "work-custody") {
		const record = readWorkCustody(entry.data);
		if (!record) return undefined;
		const sessionId = isRecord(entry.data) && typeof entry.data.sessionId === "string" ? entry.data.sessionId : "";
		return { key: `custody:${sessionId}:${record.id}`, seq: undefined };
	}
	return undefined;
}

/**
 * What lifecycle restoration reads, not the journal it is read from (senpi#7596): per session the
 * `session-lifecycle` record with the highest `seq`, and per session and record id the last `work-custody`
 * record, each at the position its first record took, which is the order the custody registry lists them in.
 * `child-lifecycle` and `interrupted-run` entries, and records restoration cannot parse, are kept as written.
 * A long-lived session writes tens of thousands of these records, so keeping them all held more than its
 * conversation did.
 */
export const lifecycleHistory: HistoryReducer<SessionEntry[]> = {
	initial: () => [],
	add: (entries, entry) => {
		if (!isLifecycleBookkeeping(entry)) return entries;
		const slot = foldSlot(entry);
		if (slot === undefined) {
			entries.push(entry);
			return entries;
		}
		let slots = foldedSlots.get(entries);
		if (slots === undefined) {
			slots = new Map();
			foldedSlots.set(entries, slots);
		}
		const held = slots.get(slot.key);
		if (held === undefined) {
			slots.set(slot.key, { index: entries.length, seq: slot.seq });
			entries.push(entry);
		} else if (slot.seq === undefined || held.seq === undefined || slot.seq > held.seq) {
			entries[held.index] = entry;
			held.seq = slot.seq;
		}
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
