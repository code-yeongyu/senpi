import type { CompactRequiredStreams } from "./compact-required-streams.ts";
import type { SessionEventFanout } from "./session-event-fanout.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { jsonChunks } from "./json-pieces.ts";
import { SEQUENCED } from "./session-acceptance-admission.ts";
import { compactDelta, demoteToDeltaOnly, type RpcRecord } from "./session-event-writer-compaction.ts";

/** H: per-admission framing is <=16 KiB including LF, independent of payload size and number of routes. */
export const MATERIALIZER_ENVELOPE_MAX_BYTES = 16_384;

/** One accepted record's payload is staged once by S13, not serialized into each admission's envelope. */
export function planMaterializerLine(
	fanout: SessionEventFanout,
	required: CompactRequiredStreams,
	peer: string,
	sessionId: string,
	type: string,
) {
	const lane = fanout.acceptance.get(sessionId);
	const registered = fanout.get(peer);
	if (!lane || !registered || !fanout.events) return undefined;
	const caller = { socketEpoch: registered.socketEpoch, sessionId };
	const stream = fanout.checkpoints.stream(caller);
	if (!stream?.routes.length || !SEQUENCED.has(type)) return undefined;
	const routes = required.routes(peer, sessionId, type);
	if (!routes.length) return undefined;
	const at = { sessionEpoch: lane.sessionEpoch, sequence: lane.acceptedSequence };
	const owner = routes[0];
	const seed = required.takeSeed(peer, sessionId);
	const events = fanout.events;
	return (record: RpcRecord) => {
		const content = compactDelta(record) ? demoteToDeltaOnly(record) : record;
		const minted = events.mint({ ...caller, admissionId: owner }, at, record, { chunks: () => payload(content) });
		if (!minted.ok) {
			const { reason } = minted;
			return {
				line: serializeJsonLine({ type: "event_lease_refused", sessionId, reason }),
				atomic: true as const,
				// RULING-124: the refusal is the peer's last record before `socket_closing` and the close.
				undelivered: () => registered.close("event_lease_refused", reason),
			};
		}
		const held = events.claim(caller, minted.value.id, owner);
		if (held.ok) for (const route of routes) held.value.admissions.add(route);
		const line = serializeJsonLine({
			type: Reflect.get(record, "type"),
			sessionId,
			eventLease: minted.value,
			materializer: {
				...at,
				generation: stream.generation,
				payload: minted.value,
				controls: seed ? [{ kind: "seed", token: seed.id, sequence: seed.cut.sequence }] : [],
			},
		});
		// Generated identifiers and one fixed control leave room for the bounded admissionId header.
		if (Buffer.byteLength(line) + 512 > MATERIALIZER_ENVELOPE_MAX_BYTES) {
			events.abandon(caller.socketEpoch, minted.value.id);
			throw new RangeError("materializer envelope exceeded H");
		}
		return {
			line,
			atomic: true as const,
			undelivered: (written: boolean) => {
				if (!written) events.abandon(caller.socketEpoch, minted.value.id);
			},
		};
	};
}

function payload(record: object): Iterable<string> {
	return jsonChunks(record, 65_536);
}
