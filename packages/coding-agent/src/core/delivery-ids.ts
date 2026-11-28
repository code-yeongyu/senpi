/**
 * Which peer deliveries a message or a transcript carries: the ids the admission ledger settles when an entry is
 * written, and the ids a restarted session answers `already_admitted` for.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { heldNoticeDeliveryIds } from "./engine-turn-hold-notices.ts";
import { isSessionControlDeliveryDetails, SESSION_CONTROL_DELIVERY_TYPE } from "./extensions/session-control-types.ts";
import type { CustomMessage } from "./messages.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import { STOP_RESUME_CUSTOM_TYPE } from "./stop-resume-directive.ts";

export function deliveryIdOf(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== SESSION_CONTROL_DELIVERY_TYPE) return undefined;
	return isSessionControlDeliveryDetails(message.details) ? message.details.delivery_id : undefined;
}

/**
 * Every delivery a message's entry settles (senpi#7628): a delivery's own, then the ones a folded turn carries after it,
 * or every held delivery the one message of a Resume after a Stop carries. The message may come back from durable
 * custody on disk, so only a list of string ids counts as carried.
 */
export function deliveryIdsIn(message: Pick<CustomMessage, "customType" | "details">): readonly string[] {
	if (message.customType === STOP_RESUME_CUSTOM_TYPE) return carriedDeliveryIds(message.details);
	if (message.customType !== SESSION_CONTROL_DELIVERY_TYPE || !isSessionControlDeliveryDetails(message.details))
		return [];
	return [message.details.delivery_id, ...carriedDeliveryIds(message.details)];
}

export function deliveryIdsOf(message: AgentMessage): readonly string[] {
	return message.role === "custom" ? deliveryIdsIn(message) : [];
}

function carriedDeliveryIds(details: unknown): string[] {
	if (typeof details !== "object" || details === null || !("folded_delivery_ids" in details)) return [];
	const carried: unknown = details.folded_delivery_ids;
	return Array.isArray(carried) ? carried.filter((id): id is string => typeof id === "string") : [];
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
