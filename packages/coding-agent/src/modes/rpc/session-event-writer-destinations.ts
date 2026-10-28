import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { omitNormalInlineMedia } from "./media-placeholders.ts";
import { compactDelta, demoteToDeltaOnly, MESSAGE_KEY, type RpcRecord } from "./session-event-writer-compaction.ts";
import { SessionEventWriterRecovery } from "./session-event-writer-recovery.ts";
import { isCorrelatedReply } from "./socket-peer-recovery.ts";

/** Per-destination delivery of one session record, moved verbatim out of `session-event-writer.ts` (S13w0, #4272). */
export abstract class SessionEventWriterDestinations extends SessionEventWriterRecovery {
	/** Puts the record on every target's FIFO in target order, or on the stdio lane for the `undefined` target. */
	protected deliver(
		sessionId: string,
		record: RpcRecord,
		tagged: RpcRecord,
		line: string,
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
		if (!isTargeted) this.fanout.rememberSnapshot(sessionId, tagged, line, placeholderLine);
		for (const target of targets) {
			if (target !== undefined && !this.fanout.get(target)) continue;
			const registered = target === undefined ? undefined : this.fanout.get(target);
			const wants =
				placeholderLine !== undefined && this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY);
			if (registered && target !== undefined) {
				const keyed = compactDelta(tagged) !== undefined && tagged.message !== null;
				registered.actor.enqueue(
					this.eventLine(target, sessionId, wants ? redacted : tagged, wants ? placeholderLine : line),
					keyed ? MESSAGE_KEY : undefined,
					undefined,
					keyed ? serializeJsonLine(demoteToDeltaOnly(tagged)) : undefined,
					isCorrelatedReply(tagged),
					mirrors.includes(target)
						? undefined
						: this.fanout.attachmentOf(target, sessionId, isTargeted, record.type),
				);
			} else this.appendSessionRecord(sessionId, wants ? (redacted as RpcRecord) : tagged, target);
		}
	}
}
