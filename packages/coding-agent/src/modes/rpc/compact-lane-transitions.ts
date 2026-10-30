import type { AssistantProgress } from "@earendil-works/pi-ai";
import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { SeededJsonAgentSessionEvent } from "../json-event.ts";
import type { CompactTransition } from "./compact-transition.ts";

/** A structured-lane record as one acceptance unit carries it: JSON-normal, with the gate's terminal cutoffs. */
export type CanonicalRecord = (SeededJsonAgentSessionEvent | AssistantProgress) & {
	readonly invalidatedBlocks?: readonly number[];
	readonly rewrittenFrom?: number;
};

/** The canonical half of one acceptance unit with its producer identity (RULING-36a R1, RULING-40). */
export interface CanonicalUnit {
	readonly record: CanonicalRecord;
	readonly carrier: RecoveryCarrier;
	readonly ordinal: number;
	readonly firstOrdinal: number;
}

const CORRELATION = ["clientMessageId", "clientTurnId", "clientMessages"] as const;

/**
 * S03b-2b's mapping: indexed updates and the three block controls fold as `seeded_block`; outer start/end and the
 * nested start/done/error as `seeded_message`, with the record's client correlation and the gate's cutoffs.
 */
export function laneTransition({
	record,
	carrier,
	ordinal,
	firstOrdinal,
}: CanonicalUnit): CompactTransition | undefined {
	const identity = { messageId: carrier.messageId, epoch: carrier.epoch, ordinal, firstOrdinal };
	const correlated = CORRELATION.filter((key) => key in record);
	const correlation = correlated.length
		? { correlation: Object.fromEntries(correlated.map((key) => [key, Reflect.get(record, key)])) }
		: {};
	const message = {
		type: "seeded_message" as const,
		...identity,
		...correlation,
		...(record.invalidatedBlocks ? { invalidatedBlocks: record.invalidatedBlocks } : {}),
		...(record.rewrittenFrom === undefined ? {} : { rewrittenFrom: record.rewrittenFrom }),
	};
	switch (record.type) {
		case "message_block_state":
		case "message_block_metadata":
		case "message_tool_arguments_reset":
			return { type: "seeded_block", ...identity, event: record };
		case "message_start":
		case "message_end":
			return { ...message, record };
		case "message_update": {
			const event = record.assistantMessageEvent;
			if (!("contentIndex" in event)) return { ...message, record: { ...record, assistantMessageEvent: event } };
			return {
				type: "seeded_block",
				...identity,
				event,
				usage: record.usage,
				...(record.messageMetadata ? { messageMetadata: record.messageMetadata } : {}),
				...correlation,
				...(record.resolvedToolName === undefined ? {} : { resolvedToolName: record.resolvedToolName }),
			};
		}
	}
	return undefined;
}
