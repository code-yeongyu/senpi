import { resetsEngineTurnHistory } from "../../../engine-turn-limit.ts";
import type { HistoryReducer } from "../../../session-history-reduce.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import { TTSR_INJECTION_CUSTOM_TYPE } from "./types.ts";

export const TTSR_LOOP_STOPPED_ENTRY_TYPE = "ttsr-loop-stopped";
export const TTSR_LOOP_STOPPED_EVENT = "ttsr:loop-stopped";

export function ttsrLoopStoppedNotice(rule: string): string {
	return `The ${rule} stream rule flagged the reply again after its correction, so no further correction was sent. Send any message to continue.`;
}

function nudgedRules(entry: SessionEntry): readonly unknown[] {
	if (entry.type !== "custom_message" || entry.customType !== TTSR_INJECTION_CUSTOM_TYPE) return [];
	const details: unknown = entry.details;
	if (typeof details !== "object" || details === null || !("rules" in details)) return [];
	return Array.isArray(details.rules) ? details.rules : [];
}

/**
 * The rules that already sent their one corrective follow-up since the last user-directed input. Read from the
 * session, so rebuilding the extension cannot re-arm them (senpi#2967), and folded, so a rebuild does not reread the
 * whole history (senpi#7607).
 */
export const correctedRules: HistoryReducer<Set<unknown>> = {
	initial: () => new Set(),
	add: (rules, entry) => {
		if (
			(entry.type === "message" && entry.message.role === "user") ||
			(entry.type === "custom_message" && resetsEngineTurnHistory(entry.customType, entry.details))
		) {
			rules.clear();
			return rules;
		}
		for (const rule of nudgedRules(entry)) rules.add(rule);
		return rules;
	},
};
