import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import type { CallProjection } from "./compact-call-model.ts";
import { COMPONENT_RECORDS } from "./compact-current-components.ts";
import type { CompactLaneCurrent } from "./compact-lane-current.ts";
import type { CanonicalUnit } from "./compact-lane-transitions.ts";
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
	/** The projection of the outstanding call a toolResult terminal settles (RULING-13 Q2), stored with it. */
	readonly call?: CallProjection | undefined;
}

/** One accepted transcript transition: its owned join, then the cold flow and persistence it carries. */
export function foldCompactTransition(
	{ settled, current }: CompactComponents,
	transition: TranscriptTransition,
	transcriptAvailable: boolean,
	epoch: string,
): void {
	if (transition.kind === "append" && transcriptAvailable) settled.append(transition);
	current.transcript(transition, settled, epoch);
}

/**
 * The compact side of one accepted record: canonical and component folds, its terminal, its persistence. The call
 * records fold before the lane commits this sequence (RULING-13 Q9), so they are not here.
 */
export function foldCompactRecord(
	{ settled, current }: CompactComponents,
	{ record, type, carrier, canonical, sequence, turnId, call }: AcceptedRecord,
): void {
	if (canonical) current.fold(canonical, sequence, turnId);
	if (COMPONENT_RECORDS.has(type)) current.foldComponent(record, sequence);
	const joined = type === "message_end" && settled.end(record, carrier, sequence, turnId, call);
	if (type === "transcript_write_failed") settled.fail(carrier, String(Reflect.get(record, "errorMessage")));
	// A failed write, or a terminal whose committed entry the lane accepted, settles its compact persistence too.
	const status = type === "transcript_write_failed" ? "failed" : joined ? "appended" : undefined;
	if (status && settled.valid(carrier)) current.status(carrier.messageId, status);
}
