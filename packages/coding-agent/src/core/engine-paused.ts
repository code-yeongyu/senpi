import { CONTINUE_FROM_LEAF_CUSTOM_TYPE } from "./continue-from-leaf.ts";
import { MANUAL_CONTINUE_CUSTOM_TYPE } from "./manual-continue.ts";
import type { SessionEntry } from "./session-manager.ts";

export const ENGINE_PAUSED_ENTRY_TYPE = "engine-paused";

export const ENGINE_TURN_START_ENTRY_TYPE = "engine-turn-start";

/** A `.` manual continue or a continue-from-leaf is the user's own request, not an automatic turn. */
export function isUserDirectedTurn(customType: string): boolean {
	return customType === MANUAL_CONTINUE_CUSTOM_TYPE || customType === CONTINUE_FROM_LEAF_CUSTOM_TYPE;
}

export function enginePauseSinceLastTurn(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "user") return false;
		if (entry.type === "custom_message" && isUserDirectedTurn(entry.customType)) return false;
		if (entry.type === "custom" && entry.customType === ENGINE_TURN_START_ENTRY_TYPE) return false;
		if (entry.type === "custom" && entry.customType === ENGINE_PAUSED_ENTRY_TYPE) return true;
	}
	return false;
}

/** The latest engine turn was the repetitive-turns correction and has not already reported a stop. */
export function settledRepetitiveTurnPause(entries: readonly SessionEntry[]): boolean {
	let corrected = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "user") return false;
		if (entry.type === "custom_message" && isUserDirectedTurn(entry.customType)) return false;
		if (entry.type === "custom" && entry.customType === ENGINE_PAUSED_ENTRY_TYPE) return false;
		if (entry.type === "custom" && entry.customType === ENGINE_TURN_START_ENTRY_TYPE) {
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
