import { familyId, memberId } from "./compact-catalog-registry.ts";
import {
	type CatalogReader,
	literalFields,
	objectSteps,
	type Steps,
	storedSteps,
	walkedSteps,
} from "./compact-catalog-steps.ts";
import { textComponent } from "./compact-catalog-transcript.ts";
import { emptyComponent, stepsComponent } from "./compact-catalog-writer.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import type { SettledReader, TerminalRow } from "./compact-settled-messages.ts";
import type { FrozenAcceptedRoot } from "./session-acceptance-lane.ts";

const SETTLED = familyId("settled");
const IDENTITY = familyId("identity");

/** A terminal as stored: its row, its payload (terminal record and correlation) spliced in, its paged call walked. */
function terminalSteps(settled: SettledReader, row: TerminalRow, valid: () => void): Steps {
	const { kind: _kind, payload, call, ...fields } = row;
	return objectSteps([
		...literalFields(fields),
		["payload", storedSteps(settled.store, payload)],
		["call", walkedSteps(settled.values, call, valid)],
	]);
}

/**
 * The settled family (R4.B2, S05, RULING-13 Q2): one `message-<terminal sequence>` member per terminal still pending
 * or failed in the cut, with its status, error, entry join, terminal payload and the call projection it retired, paged
 * and never truncated (RULING-60 Q3); or the explicit empty. The id is the terminal's own accepted sequence, so it
 * stays put while other terminals settle.
 */
export async function* settledComponents(
	reader: CatalogReader,
	settled: SettledReader,
): AsyncGenerator<CatalogComponent> {
	let count = 0;
	for await (const member of settled.members(reader.valid)) {
		if (member.kind !== "terminal") continue;
		const steps = terminalSteps(settled, member.row, reader.valid);
		yield* stepsComponent(reader.store, SETTLED, memberId("message", member.row.terminalSequence), steps);
		count += 1;
	}
	if (count === 0) yield emptyComponent("settled");
}

/**
 * The identity family (R4.B2, C1.1): the lane's own correlation state at the cut (`identity/identity`: epoch,
 * sequence, active message, turn, the standing client correlation with the sequence it took, and how many client
 * correlations this epoch refused at the protocol depth limit, RULING-67 (4)), then one `join-<ordinal>` member per
 * message joined to its durable entry in this epoch, its id the epoch-local order the join was made in.
 */
export async function* identityComponents(
	reader: CatalogReader,
	root: FrozenAcceptedRoot,
	settled: SettledReader,
): AsyncGenerator<CatalogComponent> {
	const { sessionEpoch, sequence, activeMessageId, turnId, correlation, refusedCorrelations } = root;
	const identity = { sessionEpoch, sequence, activeMessageId, turnId, correlation, refusedCorrelations };
	yield* textComponent(reader.store, IDENTITY, IDENTITY, JSON.stringify(identity));
	for await (const member of settled.members(reader.valid)) {
		if (member.kind !== "owner") continue;
		const join = JSON.stringify({ messageId: member.messageId, entryId: member.entryId });
		yield* textComponent(reader.store, IDENTITY, memberId("join", member.ordinal), join);
	}
}
