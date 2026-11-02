import { serializeJsonLine } from "./jsonl.ts";
import { GeneratedFramesCursor } from "./legacy-view-cursor.ts";
import { omitNormalInlineMedia } from "./media-placeholders.ts";
import type { ResyncCut, ResyncReason, RpcSessionResyncRequired } from "./socket-peer-recovery.ts";

export interface FrozenResyncView {
	readonly reason: ResyncReason;
	readonly placeholders: boolean;
	/** Read when the cut is read: whether the attachment the cut was taken for is gone (`closed` then). */
	readonly closedNow: (sessionId: string) => boolean;
	readonly onRelease: () => void;
}

/**
 * What one session resumes from: the message a legacy consumer holds at the cut (null when it has nothing), and the
 * frames that follow its `resync_required` before any captured record (RULING-115: an open tool call's reset).
 */
export interface ResyncResume {
	readonly message: unknown;
	readonly frames?: readonly Readonly<Record<string, unknown>>[];
}
export type ResyncMessageSource = (sessionId: string) => Promise<ResyncResume>;

class ResyncCursor extends GeneratedFramesCursor implements ResyncCut {
	readonly sessions: readonly string[];

	constructor(sessions: readonly string[], source: () => AsyncGenerator<string>, onRelease: () => void) {
		super(sessions.length === 0, source, onRelease);
		this.sessions = sessions;
	}
}

async function* resyncFrames(
	entries: () => readonly string[],
	messageOf: ResyncMessageSource,
	view: FrozenResyncView,
): AsyncGenerator<string> {
	for (const sessionId of entries()) {
		const closed = view.closedNow(sessionId);
		const { message, frames = [] } = closed ? { message: null } : await messageOf(sessionId);
		const resync: RpcSessionResyncRequired = {
			type: "resync_required",
			sessionId,
			reason: view.reason,
			message,
			...(closed ? { closed: true as const } : {}),
		};
		for (const frame of [resync, ...frames.map((frame) => ({ ...frame, sessionId }))])
			yield serializeJsonLine(view.placeholders ? omitNormalInlineMedia(frame) : frame);
	}
}

/**
 * A shed's cut: one `resync_required` frame per session, read in order when the gap is delivered. `entries` fixes
 * the sessions at the first read (the shed's set, or today's delivery-time union), `messageOf` each one's message.
 */
export function resyncCut(
	sessions: readonly string[],
	entries: () => readonly string[],
	messageOf: ResyncMessageSource,
	view: FrozenResyncView,
	track: (onRelease: () => void) => () => void,
): ResyncCut {
	return new ResyncCursor(sessions, () => resyncFrames(entries, messageOf, view), track(view.onRelease));
}
