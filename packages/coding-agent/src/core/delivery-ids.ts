/**
 * Which peer deliveries a message or a transcript carries: the ids the admission ledger settles when an entry is
 * written, and the ids a restarted session answers `already_admitted` for.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { heldNoticeDeliveryIds } from "./engine-turn-hold-notices.ts";
import { isSessionControlDeliveryDetails, SESSION_CONTROL_DELIVERY_TYPE } from "./extensions/session-control-types.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";

export function deliveryIdOf(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== SESSION_CONTROL_DELIVERY_TYPE) return undefined;
	return isSessionControlDeliveryDetails(message.details) ? message.details.delivery_id : undefined;
}

/**
 * Every delivery id the transcript holds an entry for: what answers for the process-lifetime ledger after a restart.
 * A delivery held while paused lives only in its `session-notice` entry until a turn takes it (senpi#7588).
 */
export const writtenDeliveryIds: HistoryReducer<Set<string>> = {
	initial: () => new Set(),
	add: (ids, entry) => {
		if (entry.type === "custom" && entry.customType === "session-notice")
			for (const id of heldNoticeDeliveryIds(entry.data)) ids.add(id);
		else if (
			entry.type === "custom_message" &&
			entry.customType === SESSION_CONTROL_DELIVERY_TYPE &&
			isSessionControlDeliveryDetails(entry.details)
		)
			ids.add(entry.details.delivery_id);
		return ids;
	},
};
