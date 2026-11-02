import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "./agent-session.ts";
import { engineWakeSource } from "./engine-turn-hold.ts";
import type { CustomMessage } from "./messages.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionLifecycleController } from "./session-lifecycle.ts";
import type { DeliveryTicketId } from "./session-lifecycle-types.ts";
import { isRecord } from "./work-custody-record.ts";
import { recoveryCarrier } from "./session-recovery-identity.ts";

/** Keep delivery identities, not materialized conversation history, between engine turns. */
export const lifecycleDeliveryEntries: HistoryReducer<Map<string, string>> = {
	initial: () => new Map(),
	add: (entries, entry) => {
		if (entry.type === "custom_message") {
			const ticket = messageTicket(entry);
			if (ticket && !entries.has(ticket)) entries.set(ticket, entry.id);
		}
		return entries;
	},
};

export function messageTicket(message: Pick<CustomMessage, "details">): DeliveryTicketId | undefined {
	return isRecord(message.details) && typeof message.details.ticketId === "string"
		? message.details.ticketId
		: undefined;
}

/** Synchronous at message_start: transcript first, then the consuming run's custody. */
export function consumeLifecycleDelivery(
	session: AgentSession,
	controller: SessionLifecycleController,
	message: AgentMessage,
): string | undefined {
	if (message.role !== "custom") return undefined;
	const ticketId = messageTicket(message);
	if (!ticketId) return undefined;
	const custody = controller.obligations.active.find((record) => record.ticketId === ticketId);
	if (!custody) return undefined;
	if (custody.state === "consumed") return undefined;
	const runId = controller.ledger.runId;
	if (!runId) return undefined;
	const existing = session.sessionManager.reduceHistory(lifecycleDeliveryEntries).get(ticketId);
	const transcriptEntryId =
		existing ??
		session.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			{ recoveryOwner: recoveryCarrier(message) },
		);
	controller.obligations.consumed(ticketId, { runId, transcriptEntryId });
	return transcriptEntryId;
}

/**
 * #3860 currently returns void from note(). Capture its appended notice by
 * ticket identity instead of introducing another held-message store.
 */
export function heldLifecycleNotice(
	session: AgentSession,
	ticketId: DeliveryTicketId,
	customType: string,
): string | undefined {
	for (const entry of session.sessionManager.getEntries().toReversed()) {
		if (entry.type !== "custom" || entry.customType !== "session-notice" || !isRecord(entry.data)) continue;
		if (
			isRecord(entry.data.message) &&
			isRecord(entry.data.message.details) &&
			entry.data.message.details.ticketId === ticketId &&
			typeof entry.data.noticeId === "string"
		)
			return entry.data.noticeId;
		// Goal notices deliberately store no pre-rendered message (#3860), so only a goal continuation may claim one.
		if (
			engineWakeSource(customType) === "goal" &&
			entry.data.producer === "goal" &&
			entry.data.message === undefined &&
			typeof entry.data.noticeId === "string"
		)
			return entry.data.noticeId;
	}
	return undefined;
}
