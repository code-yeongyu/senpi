import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import type { CallFold } from "./compact-call-fold.ts";
import { toolcallIndex } from "./compact-call-identity.ts";
import { callIdentity } from "./compact-call-model.ts";
import { COMPONENT_RECORDS } from "./compact-current-components.ts";
import type { CompactLaneCurrent } from "./compact-lane-current.ts";
import type { CanonicalUnit } from "./compact-lane-transitions.ts";
import type { LiveIdentity } from "./compact-message-identity.ts";
import type { CompactSettledMessages } from "./compact-settled-messages.ts";

/** The compact components one lane epoch feeds: its settled terminals and its current state. */
export interface CompactComponents {
	readonly settled: CompactSettledMessages;
	readonly current: CompactLaneCurrent;
}

export interface AcceptedRecord {
	readonly record: object;
	readonly type: string;
	readonly carrier: RecoveryCarrier | undefined;
	readonly canonical: CanonicalUnit | undefined;
	readonly sequence: number;
	readonly turnId: string | null;
	/**
	 * The call fold of a call record: the projection of the outstanding call a toolResult terminal settles (RULING-13 Q2),
	 * stored with it, and the call an execution or hook record changed (RULING-123).
	 */
	readonly call?: CallFold | undefined;
}

/**
 * One accepted transcript transition: its owned join, then the cold flow and persistence it carries. Returns the
 * message an append joined, the id its `join-<n>` member records.
 */
export function foldCompactTransition(
	{ settled, current }: CompactComponents,
	transition: TranscriptTransition,
	transcriptAvailable: boolean,
	epoch: string,
): string | undefined {
	const owner = transition.kind === "append" && transcriptAvailable ? settled.append(transition) : undefined;
	current.transcript(transition, settled, epoch);
	return owner;
}

/**
 * The compact side of one accepted record: canonical and component folds, its terminal, its persistence. The call
 * records fold before the lane commits this sequence (RULING-13 Q9), so they are not here. Returns the identity the
 * settled store recorded for this record's message (RULING-120), or the call a live call record belongs to: the one its
 * fold changed, or for a `toolcall_*` update the call owning the streamed block once it folded (RULING-123); undefined
 * when there is none.
 */
export function foldCompactRecord(
	{ settled, current }: CompactComponents,
	{ record, type, carrier, canonical, sequence, turnId, call }: AcceptedRecord,
): LiveIdentity | undefined {
	if (canonical) current.fold(canonical, sequence, turnId);
	if (COMPONENT_RECORDS.has(type)) current.foldComponent(record, sequence);
	const ended = type === "message_end" ? settled.end(record, carrier, sequence, turnId, call?.projection) : undefined;
	const failed =
		type === "transcript_write_failed"
			? settled.fail(carrier, String(Reflect.get(record, "errorMessage")))
			: undefined;
	// A failed write, or a terminal whose committed entry the lane accepted, settles its compact persistence too.
	const status = type === "transcript_write_failed" ? "failed" : ended?.joined ? "appended" : undefined;
	if (status && settled.valid(carrier)) current.status(carrier.messageId, status);
	const block = toolcallIndex(record);
	const streamed =
		block !== undefined && carrier ? callIdentity(current.callOwning(carrier.messageId, block)) : undefined;
	return ended?.identity ?? failed ?? call?.identity ?? streamed;
}
