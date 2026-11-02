import { COMPACT_RECORD_MAX_BYTES } from "./compact-event-leases.ts";
import { COMPACT_EVENTS_CAPABILITY, MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { jsonSize } from "./json-pieces.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { omitNormalInlineMedia } from "./media-placeholders.ts";
import { compactDelta, demoteToDeltaOnly, MESSAGE_KEY, type RpcRecord } from "./session-event-writer-compaction.ts";
import { SessionEventWriterRecovery } from "./session-event-writer-recovery.ts";
import { isCorrelatedReply } from "./socket-peer-recovery.ts";
import { materializerLine } from "./compact-materializer-line.ts";
import { declarationReply } from "./compact-negotiation.ts";
import { unvouchedCall } from "./compact-call-identity.ts";

/** A record's legacy line, encoded on first use: a record no legacy destination needs never builds it (RULING-81 X06). */
export class RecordLine {
	private readonly record: object;
	private encoded: string | undefined;

	constructor(record: object, encoded?: string) {
		this.record = record;
		this.encoded = encoded;
	}

	get text(): string {
		this.encoded ??= serializeJsonLine(this.record);
		return this.encoded;
	}

	/** The line if some destination already built it; undefined otherwise. */
	get built(): string | undefined {
		return this.encoded;
	}
}

/**
 * A destination's line, and for an event-lease envelope the release that runs if the actor never writes it. `record`:
 * the stamped record a compact line (inline or an `eventLease` envelope) was built from, so its delta-only demotion
 * keeps the stamp (RULING-123).
 */
interface EventLine {
	readonly line: string;
	readonly record?: RpcRecord;
	readonly undelivered?: (written: boolean) => void;
	readonly atomic?: boolean;
}

/**
 * A record's compact copy: the record itself, or its stamped form when the lane names an identity for it (RULING-120,
 * RULING-123). Built once per delivery and shared by every compact peer, so an oversized copy keys one staged text
 * (the lease owner shares staging by record object), never one per peer (S13 X07).
 */
interface CompactCopy {
	readonly stamped: RpcRecord;
	readonly line: RecordLine;
}

/** Per-destination delivery of one session record, moved verbatim out of `session-event-writer.ts` (S13w0, #4272). */
export abstract class SessionEventWriterDestinations extends SessionEventWriterRecovery {
	/** Puts the record on every target's FIFO in target order, or on the stdio lane for the `undefined` target. */
	protected deliver(
		sessionId: string,
		record: RpcRecord,
		tagged: RpcRecord,
		line: RecordLine,
		targets: readonly (string | undefined)[],
		mirrors: readonly string[],
		isTargeted: boolean,
		/** A targeted reply's destination check, repeated immediately before its write (#4728). */
		current?: () => boolean,
	): void {
		// A record is only walked and re-serialized when a target asked for placeholders;
		// otherwise this is byte-for-byte today's path, with serializeJsonLine called once.
		const hasPlaceholderTarget = targets.some((target) =>
			this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY),
		);
		const redacted = hasPlaceholderTarget
			? omitNormalInlineMedia(tagged, this.mediaPersisters.get(sessionId))
			: tagged;
		const placeholderLine = redacted === tagged ? undefined : serializeJsonLine(redacted);
		const placeholder = new RecordLine(redacted, placeholderLine);
		if (!isTargeted && !this.fanout.acceptance.has(sessionId))
			this.fanout.rememberSnapshot(sessionId, tagged, line.text, placeholderLine);
		const copies = new Map<RpcRecord, CompactCopy>();
		for (const target of targets) {
			if (target !== undefined && !this.fanout.get(target)) continue;
			const registered = target === undefined ? undefined : this.fanout.get(target);
			const wants =
				placeholderLine !== undefined && this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY);
			if (registered && target !== undefined) {
				const out = this.eventLine(
					target,
					sessionId,
					wants ? redacted : tagged,
					wants ? placeholder : line,
					copies,
				);
				const keyed = !out.atomic && compactDelta(tagged) !== undefined && tagged.message !== null;
				registered.actor.enqueue(
					out.line,
					keyed ? MESSAGE_KEY : undefined,
					out.undelivered,
					keyed ? serializeJsonLine(demoteToDeltaOnly(out.record ?? tagged)) : undefined,
					isCorrelatedReply(tagged),
					mirrors.includes(target)
						? undefined
						: this.fanout.attachmentOf(target, sessionId, isTargeted, record.type),
					current,
				);
			} else this.appendSessionRecord(sessionId, wants ? (redacted as RpcRecord) : tagged, target);
		}
	}

	/**
	 * What `target` receives for `record` (S13, R4.B6): a record past F, for a connection that selected compact events and
	 * holds this lane-owned session, becomes an `eventLease` envelope at the record's accepted sequence, its content
	 * staged from the line another destination built or else streamed from the record (never one legacy line); every
	 * other destination gets the legacy line. Past the peer's lease bound, or when the record cannot be staged, the peer
	 * gets a typed refusal and its connection closes (fail closed, like a plain peer's overflow). A stamped copy is
	 * built once per delivery (`copies`), so every compact peer leases the same staged text.
	 */
	private eventLine(
		target: string,
		sessionId: string,
		record: RpcRecord,
		line: RecordLine,
		copies: Map<RpcRecord, CompactCopy>,
	): EventLine {
		const reply = declarationReply(record, this.compactSelection(target));
		if (reply !== undefined && reply !== record) return { line: serializeJsonLine(reply) };
		const events = this.fanout.events;
		const lane = this.fanout.acceptance.get(sessionId);
		if (
			!lane &&
			this.compactSelection(target)?.selected &&
			this.status.mirrorTargets(sessionId, String(Reflect.get(record, "type"))).includes(target)
		)
			return {
				line: serializeJsonLine({ type: "compact_refused", sessionId, reason: "compact_endpoint_unsupported" }),
				undelivered: () => this.fanout.get(target)?.connection.close?.(),
			};
		const admissionId =
			this.ordinaryRoute(target, sessionId)?.routes[0] ?? this.fanout.admissionOf(target, sessionId);
		const socketEpoch = this.fanout.get(target)?.socketEpoch;
		if (!events || !lane || admissionId === undefined || socketEpoch === undefined) return { line: line.text };
		if (!this.fanout.connectionHas(target, COMPACT_EVENTS_CAPABILITY)) return { line: line.text };
		// RULING-120 (#5331): only this compact peer's copy carries the ids the settled overlay pages for its message;
		// RULING-123 (#5346): and a live call record's snapshot key, or `callUnknown` when the lane vouched for none.
		let copy = copies.get(record);
		if (!copy) {
			const identity = lane.identities.of(record.type, lane.acceptedSequence) ?? unvouchedCall(record);
			const stamped = identity ? { ...record, ...identity } : record;
			copy = { stamped, line: identity ? new RecordLine(stamped) : line };
			copies.set(record, copy);
		}
		const { stamped, line: stampedLine } = copy;
		const identity = stamped !== record;
		const materializer = materializerLine(this.fanout, this.required, target, sessionId, stamped);
		if (materializer) return materializer;
		const built = stampedLine.built;
		const size =
			built === undefined ? jsonSize(stamped) : { bytes: Buffer.byteLength(built) - 1, units: built.length - 1 };
		if (size.bytes + 1 <= COMPACT_RECORD_MAX_BYTES)
			return { line: stampedLine.text, ...(identity ? { record: stamped } : {}) };
		const at = { sessionEpoch: lane.sessionEpoch, sequence: lane.acceptedSequence };
		const routes = this.ordinaryRoute(target, sessionId)?.routes ?? [];
		const owner = routes[0] ?? admissionId;
		const minted = events.mint({ socketEpoch, sessionId, admissionId: owner }, at, stamped, built ?? size);
		if (minted.ok) {
			const { id } = minted.value;
			const held = events.claim({ socketEpoch, sessionId }, id, owner);
			if (held.ok) for (const route of routes) held.value.admissions.add(route);
			return {
				line: serializeJsonLine({ type: Reflect.get(record, "type"), sessionId, eventLease: minted.value }),
				...(identity ? { record: stamped } : {}),
				// The lease lives only if its envelope is written: every drop path of the socket actor ends it unseen.
				undelivered: (written) => {
					if (!written) events.abandon(socketEpoch, id);
				},
			};
		}
		process.stderr.write(`senpi rpc connection ${target} event lease refused (${minted.reason}); closing\n`);
		this.fanout.get(target)?.connection.close?.();
		return { line: serializeJsonLine({ type: "event_lease_refused", sessionId, reason: minted.reason }) };
	}
}
