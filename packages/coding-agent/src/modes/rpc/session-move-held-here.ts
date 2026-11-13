/**
 * What a move step says when the only holder of the session it met is this host's own process (senpi#6454). A
 * release answers at its close grace whether or not the session's runtime has stopped, and that runtime holds the
 * session file until the last step of its dispose. `SessionHeldError`'s own text is for a session open in another
 * process: here it would name this host as that process and tell the user to quit it. The code stays
 * `session_held`; a session any other process holds keeps that error's text.
 */
import { SessionHeldError } from "../../core/session-hold-errors.ts";

export const RELEASED_BEFORE_STOPPED_DETAIL =
	"This session had not finished stopping on this host when it was released, so nothing was exported. Give it back with finish and a declined answer.";

const FINISH_BEFORE_STOPPED_DETAIL =
	"This session has not finished stopping on this host, so it was not given back. Send finish again.";

const EXPORT_BEFORE_STOPPED_DETAIL =
	"This session has not finished stopping on this host, so it was not exported. Send export again once it has stopped.";

export const heldByThisProcessOnly = (cause: unknown): boolean =>
	cause instanceof SessionHeldError && cause.holders.every((holder) => holder.pid === process.pid);

/** What a refused `finish` or `export` op says instead of that error's text; `undefined` for every other refusal. */
export function stillStoppingHereDetail(op: string, cause: unknown): string | undefined {
	if (!heldByThisProcessOnly(cause)) return undefined;
	if (op === "finish") return FINISH_BEFORE_STOPPED_DETAIL;
	if (op === "export") return EXPORT_BEFORE_STOPPED_DETAIL;
	return undefined;
}
