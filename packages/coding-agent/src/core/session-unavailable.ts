/**
 * What a runtime without the calling session's state answers when a tool reaches for it (senpi#6749). A hand runs a
 * loop's tool call with the session's IDENTITY always (its id, carried on every call) and with the session's RECORD
 * (entries, active tools, prompt options, loop state, placement) only when the tool declares `sessionBound`, so the
 * loop's call carries the session port's read half. Reaching for a part the call does not carry throws this, with a
 * code the loop can route on instead of a message.
 */
export type SessionUnavailableCode = "session_record_unavailable" | "session_identity_unavailable";

export class SessionUnavailableError extends Error {
	override readonly name = "SessionUnavailableError";
	readonly code: SessionUnavailableCode;
	/** What was reached for, e.g. `sessionManager.getBranch`. */
	readonly member: string;
	constructor(code: SessionUnavailableCode, member: string) {
		super(`${code}: ${member} is not available to this call`);
		this.code = code;
		this.member = member;
	}
}
