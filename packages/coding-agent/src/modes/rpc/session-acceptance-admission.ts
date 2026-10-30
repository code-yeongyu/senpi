import { randomUUID } from "node:crypto";
import { correlatedRecord } from "./client-message-events.ts";
import type { CallFold } from "./compact-call-fold.ts";
import { CALL_ONLY_RECORDS, CALL_RECORDS } from "./compact-call-model.ts";
import type { CompactLaneCurrent } from "./compact-lane-current.ts";

/** Where the lane stands, or where an admitted record lands: its sequence and the turn it belongs to. */
export interface LanePlace {
	readonly sequence: number;
	readonly turnId: string | null;
}

/** An admitted record's place and what its call fold produced, if it is a call record. */
export interface AdmittedRecord extends LanePlace {
	readonly call: CallFold | undefined;
}

/** The outer client correlation standing in the lane, and the sequence its transition took (C1.1). */
export interface AcceptedCorrelation {
	readonly sequence: number;
	readonly clientMessageId: unknown;
	readonly clientTurnId: unknown;
	readonly clientMessages: unknown;
}

export function field(record: object, key: string): unknown {
	return key in record ? Reflect.get(record, key) : undefined;
}

function turnScoped(type: string, record: object): boolean {
	if (type === "turn_end" || type.startsWith("tool_execution_")) return true;
	if (!type.startsWith("message_")) return false;
	const role = field(Object(field(record, "message")), "role");
	return role === "assistant" || role === "toolResult";
}

/**
 * The calls component folds first, at the sequence and turn this record would take: an ignored call-only record
 * changes no component, takes no sequence, mints no turn, commits no correlation and publishes no root
 * (RULING-13 Q9), so the lane commits nothing before it decides. Returns the place the record takes, or undefined
 * when it is ignored.
 */
export function admitRecord(
	current: CompactLaneCurrent,
	record: object,
	type: string,
	at: LanePlace,
): AdmittedRecord | undefined {
	const mintsTurn = type === "turn_start" || (at.turnId === null && turnScoped(type, record));
	const turnId = mintsTurn ? randomUUID() : at.turnId;
	const next = at.sequence + 1;
	const call = CALL_RECORDS.has(type) ? current.foldCall(record, next, turnId) : undefined;
	if (call && !call.changed && CALL_ONLY_RECORDS.has(type)) return undefined;
	return { sequence: next, turnId, call };
}

/** A change of the outer client correlation is its own transition, sequenced just before its record (C1.1). */
export function correlationChange(
	standing: AcceptedCorrelation | null,
	turnId: string | null,
	record: object,
): Omit<AcceptedCorrelation, "sequence"> | undefined {
	// Within a turn, any identity-less correlated record other than turn_start (user input, an extension steer, a
	// mid-turn session_abort, custom-role message_* records) keeps the standing correlation and gains no client identity
	// of its own; only a new turn boundary ends it (ruling B).
	const identified = "clientMessageId" in record || "clientTurnId" in record;
	if (!identified && (standing === null || !correlatedRecord(record))) return undefined;
	if (!identified && turnId !== null && field(record, "type") !== "turn_start") return undefined;
	const next = {
		clientMessageId: field(record, "clientMessageId"),
		clientTurnId: field(record, "clientTurnId"),
		clientMessages: field(record, "clientMessages"),
	};
	const current = standing;
	const currentMessages = current?.clientMessages;
	const nextMessages = next.clientMessages;
	if (
		current !== null &&
		current.clientMessageId === next.clientMessageId &&
		current.clientTurnId === next.clientTurnId &&
		(currentMessages === nextMessages ||
			(Array.isArray(currentMessages) &&
				Array.isArray(nextMessages) &&
				currentMessages.length === nextMessages.length &&
				currentMessages.every(
					(identity: unknown, index: number) =>
						field(Object(identity), "clientMessageId") ===
							field(Object(nextMessages[index]), "clientMessageId") &&
						field(Object(identity), "clientTurnId") === field(Object(nextMessages[index]), "clientTurnId"),
				)))
	)
		return undefined;
	return next;
}
