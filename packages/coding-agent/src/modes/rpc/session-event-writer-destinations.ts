import { COMPACT_RECORD_MAX_BYTES } from "./compact-event-leases.ts";
import { COMPACT_EVENTS_CAPABILITY, MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { jsonSize } from "./json-pieces.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { omitNormalInlineMedia } from "./media-placeholders.ts";
import { compactDelta, demoteToDeltaOnly, MESSAGE_KEY, type RpcRecord } from "./session-event-writer-compaction.ts";
import { SessionEventWriterRecovery } from "./session-event-writer-recovery.ts";
import { isCorrelatedReply } from "./socket-peer-recovery.ts";

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

/** A destination's line, and for an event-lease envelope the release that runs if the actor never writes it. */
interface EventLine {
	readonly line: string;
	readonly undelivered?: (written: boolean) => void;
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
		for (const target of targets) {
			if (target !== undefined && !this.fanout.get(target)) continue;
			const registered = target === undefined ? undefined : this.fanout.get(target);
			const wants =
				placeholderLine !== undefined && this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY);
			if (registered && target !== undefined) {
				const keyed = compactDelta(tagged) !== undefined && tagged.message !== null;
				const out = this.eventLine(target, sessionId, wants ? redacted : tagged, wants ? placeholder : line);
				registered.actor.enqueue(
					out.line,
					keyed ? MESSAGE_KEY : undefined,
					out.undelivered,
					keyed ? serializeJsonLine(demoteToDeltaOnly(tagged)) : undefined,
					isCorrelatedReply(tagged),
					mirrors.includes(target)
						? undefined
						: this.fanout.attachmentOf(target, sessionId, isTargeted, record.type),
				);
			} else this.appendSessionRecord(sessionId, wants ? (redacted as RpcRecord) : tagged, target);
		}
	}

	/**
	 * What `target` receives for `record` (S13, R4.B6): a record past F, for a connection that selected compact events and
	 * holds this lane-owned session, becomes an `eventLease` envelope at the record's accepted sequence, its content
	 * staged from the line another destination built or else streamed from the record (never one legacy line); every
	 * other destination gets the legacy line. Past the peer's lease bound, or when the record cannot be staged, the peer
	 * gets a typed refusal and its connection closes (fail closed, like a plain peer's overflow).
	 */
	private eventLine(target: string, sessionId: string, record: object, line: RecordLine): EventLine {
		const events = this.fanout.events;
		const lane = this.fanout.acceptance.get(sessionId);
		const admissionId = this.fanout.admissionOf(target, sessionId);
		const socketEpoch = this.fanout.get(target)?.socketEpoch;
		if (!events || !lane || admissionId === undefined || socketEpoch === undefined) return { line: line.text };
		if (!this.fanout.connectionHas(target, COMPACT_EVENTS_CAPABILITY)) return { line: line.text };
		const built = line.built;
		const size =
			built === undefined ? jsonSize(record) : { bytes: Buffer.byteLength(built) - 1, units: built.length - 1 };
		if (size.bytes + 1 <= COMPACT_RECORD_MAX_BYTES) return { line: line.text };
		const at = { sessionEpoch: lane.sessionEpoch, sequence: lane.acceptedSequence };
		const minted = events.mint({ socketEpoch, sessionId, admissionId }, at, record, built ?? size);
		if (minted.ok) {
			const { id } = minted.value;
			return {
				line: serializeJsonLine({ type: Reflect.get(record, "type"), sessionId, eventLease: minted.value }),
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
