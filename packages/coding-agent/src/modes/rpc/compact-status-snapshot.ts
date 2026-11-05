import type { EventLeases } from "./compact-event-leases.ts";
import { FRAGMENT_MAX_BYTES } from "./compact-recovery-bytes.ts";
import { CompactAdmissionError } from "./compact-admissions.ts";
import { jsonChunks } from "./json-pieces.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import type { SessionStatusRecord } from "./session-status.ts";

/** Host-wide seq-0 owner. Both synchronous passes stream rows, never collect a status array.
 * S11 pages the immutable S13 substrate; consumption and peer-end use its existing lease lifecycle.
 */
export function statusSnapshot(
	events: EventLeases,
	socketEpoch: string,
	admissionId: string,
	sessionId: string,
	rows: () => Iterable<SessionStatusRecord>,
) {
	const chunks = function* () {
		yield '{"seq":0,"snapshot":[';
		let comma = "";
		for (const row of rows()) {
			yield comma;
			yield* jsonChunks(row, FRAGMENT_MAX_BYTES / 2);
			comma = ",";
		}
		yield "]}";
	};
	const minted = events.mint(
		{ socketEpoch, sessionId, admissionId },
		{ sessionEpoch: hostInstanceId(), sequence: 0 },
		{},
		{ chunks },
	);
	if (!minted.ok) throw new CompactAdmissionError("storage_unavailable");
	return minted.value;
}
