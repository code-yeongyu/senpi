import { isUserDirectedTurn } from "./engine-turn-limit.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionEntry } from "./session-manager.ts";

export const ENGINE_PAUSED_ENTRY_TYPE = "engine-paused";

/** What an entry says about the latest engine turn: a turn began, the engine paused, or neither. */
function turnPauseEvent(entry: SessionEntry): "turn" | "paused" | undefined {
	if (entry.type === "message" && entry.message.role === "user") return "turn";
	if (entry.type === "custom_message" && isUserDirectedTurn(entry.customType)) return "turn";
	if (entry.type === "custom" && entry.customType === "engine-turn-start") return "turn";
	if (entry.type === "custom" && entry.customType === ENGINE_PAUSED_ENTRY_TYPE) return "paused";
	return undefined;
}

export function enginePauseSinceLastTurn(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const event = turnPauseEvent(entries[index]);
		if (event !== undefined) return event === "paused";
	}
	return false;
}

/** `enginePauseSinceLastTurn` over a session's whole history, folded so a reader never rereads it (senpi#7607). */
export const enginePauseHistory: HistoryReducer<boolean> = {
	initial: () => false,
	add: (paused, entry) => {
		const event = turnPauseEvent(entry);
		return event === undefined ? paused : event === "paused";
	},
};

/** The latest engine turn was the repetitive-turns correction and has not already reported a stop. */
export function settledRepetitiveTurnPause(entries: readonly SessionEntry[]): boolean {
	let corrected = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "user") return false;
		if (entry.type === "custom_message" && isUserDirectedTurn(entry.customType)) return false;
		if (entry.type === "custom" && entry.customType === ENGINE_PAUSED_ENTRY_TYPE) return false;
		if (entry.type === "custom" && entry.customType === "engine-turn-start") {
			const data: unknown = entry.data;
			return (
				corrected &&
				typeof data === "object" &&
				data !== null &&
				"customType" in data &&
				data.customType === "ttsr-injection"
			);
		}
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== "ttsr-injection") continue;
		const details: unknown = entry.details;
		corrected =
			typeof details === "object" &&
			details !== null &&
			"rules" in details &&
			Array.isArray(details.rules) &&
			details.rules.includes("repetitive-turns");
	}
	return false;
}
