import { serializeJsonLine } from "./jsonl.ts";
import { type FrozenFrames, FrozenFramesCursor, type LegacyViewCursor } from "./legacy-view-cursor.ts";
import { observeLifecycleDelivery } from "./lifecycle-delivery.ts";
import { carriesMedia, omitNormalInlineMedia } from "./media-placeholders.ts";

/**
 * A replayable snapshot line.
 *
 * `placeholderLine` is the `media_placeholders` variant. The writer supplies it only when
 * a capable connection was already attached when the record was emitted; a connection that
 * attaches later still needs it, so the frozen line supplies the source on the first
 * capable replay. Only the derived line is memoized; no provider object is retained.
 * `mayCarryMedia` is the type gate taken at acceptance: a record whose type cannot carry
 * media (every `message_update` partial) replays its `line` with no parse at all; only
 * media-bearing records parse their frozen line, once.
 */
type SnapshotRecord = {
	readonly line: string;
	placeholderLine?: string;
	readonly hasMessage: boolean;
	readonly mayCarryMedia: boolean;
};

/** The placeholder variant of a remembered record, derived and memoized on first use. */
function snapshotPlaceholderLine(record: SnapshotRecord): string {
	if (record.placeholderLine !== undefined) return record.placeholderLine;
	if (!record.mayCarryMedia) return record.line;
	const source = JSON.parse(record.line) as Record<string, unknown>;
	const redacted = omitNormalInlineMedia(source);
	record.placeholderLine = redacted === source ? record.line : serializeJsonLine(redacted);
	return record.placeholderLine;
}

/** The legacy frames a cut is read in: lifecycle, the active message's records, then the open questions. */
export interface FrozenAttachView {
	readonly placeholders: boolean;
	readonly now: number;
	readonly onRelease: () => void;
}

/**
 * Today's retained replay source, kept only for a session that owns no acceptance lane (RULING-25 Q5: an
 * externally constructed session keeps today's retention until its legacy adapter is ruled); a lane-owned session
 * is never written here, its late peers read the frozen compact current-state view (`compact-legacy-view.ts`).
 */
export class LegacyReplayStore {
	private readonly sessionSnapshots = new Map<string, SnapshotRecord[]>();
	private readonly lifecycleSnapshots = new Map<string, SnapshotRecord>();
	private readonly pendingQuestions = new Map<string, Map<string, Record<string, unknown>>>();
	private cursors = 0;

	/** Legacy views of either source not yet released: zero once every barrier ended (R3.C6.4 accounting). */
	get openCursors(): number {
		return this.cursors;
	}

	pendingQuestionCount(sessionId: string): number {
		return this.pendingQuestions.get(sessionId)?.size ?? 0;
	}

	remember(sessionId: string, value: Record<string, unknown>, line: string, placeholderLine?: string): void {
		const record: SnapshotRecord = {
			line,
			placeholderLine,
			hasMessage: value.message != null,
			mayCarryMedia: carriesMedia(value),
		};
		if (value.type === "session_lifecycle") {
			this.lifecycleSnapshots.set(sessionId, record);
			return;
		}
		if (value.type === "extension_ui_request" && value.method === "question" && typeof value.id === "string") {
			const pending = this.pendingQuestions.get(sessionId) ?? new Map<string, Record<string, unknown>>();
			// Writer acceptance already detached and JSON-normalized the frame.
			pending.set(value.id, { ...value });
			this.pendingQuestions.set(sessionId, pending);
			return;
		}
		if (value.type === "question_resolved" && typeof value.id === "string") {
			this.pendingQuestions.get(sessionId)?.delete(value.id);
			return;
		}
		if (value.type === "question_updated" && typeof value.id === "string") {
			const frame = this.pendingQuestions.get(sessionId)?.get(value.id);
			if (frame) Object.assign(frame, { deadlineAtMs: value.deadlineAtMs, remainingMs: value.remainingMs });
			return;
		}
		const event = value.assistantMessageEvent as Record<string, unknown> | undefined;
		if (value.type === "message_start" || (value.type === "message_update" && event?.type === "text_start")) {
			this.sessionSnapshots.set(sessionId, [record]);
		} else if (this.sessionSnapshots.has(sessionId)) {
			this.sessionSnapshots.get(sessionId)?.push(record);
		}
		if (value.type === "message_end") this.sessionSnapshots.delete(sessionId);
	}

	forget(sessionId: string): void {
		this.pendingQuestions.delete(sessionId);
		this.sessionSnapshots.delete(sessionId);
		this.lifecycleSnapshots.delete(sessionId);
	}

	/** A late peer's baseline, frozen now: the array ref and its length, the question frames at this clock. */
	freezeAttach(sessionId: string, view: FrozenAttachView): LegacyViewCursor {
		const lifecycle = this.lifecycleSnapshots.get(sessionId);
		const records = this.sessionSnapshots.get(sessionId) ?? [];
		const length = records.length;
		const head = lifecycle === undefined ? 0 : 1;
		const questions = [...(this.pendingQuestions.get(sessionId)?.values() ?? [])].map((frame) =>
			serializeJsonLine({
				...frame,
				remainingMs: typeof frame.deadlineAtMs === "number" ? Math.max(0, frame.deadlineAtMs - view.now) : 0,
			}),
		);
		const variant = (record: SnapshotRecord) => (view.placeholders ? snapshotPlaceholderLine(record) : record.line);
		const frames: FrozenFrames = {
			count: head + length + questions.length,
			frame: (index) => {
				if (lifecycle !== undefined && index === 0)
					return serializeJsonLine(observeLifecycleDelivery(JSON.parse(lifecycle.line)));
				const at = index - head;
				if (at < length) return variant(records[at]);
				return questions[at - length];
			},
		};
		return new FrozenFramesCursor(() => frames, this.track(view.onRelease));
	}

	/**
	 * The message slot of a resync frame, read when the cut is read: the latest retained record carrying a message.
	 * The producer may mutate its partial object after emission; the serialized record, not that object, fixes it.
	 */
	latestMessage(sessionId: string): unknown {
		const record = this.sessionSnapshots.get(sessionId)?.findLast((record) => record.hasMessage);
		const frozen: unknown = record === undefined ? undefined : JSON.parse(record.line);
		return typeof frozen === "object" && frozen !== null && "message" in frozen ? frozen.message : null;
	}

	/** Counts a legacy view of either source open until its release runs once. */
	track = (onRelease: () => void): (() => void) => {
		this.cursors += 1;
		return () => {
			this.cursors -= 1;
			onRelease();
		};
	};
}
