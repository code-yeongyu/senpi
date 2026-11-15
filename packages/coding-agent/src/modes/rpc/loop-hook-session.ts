/**
 * The loop session a hand's call sees, read-only (`ctx.sessionManager`), bound to that call only: the session's id and
 * what the loop carried, never its transcript path; everything else is loop-side.
 */
import { join } from "node:path";
import type { HistoryReducer } from "../../core/session-history-reduce.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import type { CarriedSession } from "./loop-hook-call.ts";

/**
 * The one deliberate refusal after a loop-hook call ended (option A): the loop session's identity is bound to that call
 * only, so reading it from a kept context afterwards throws this instead of answering. Every other member a call binds
 * keeps working after it (late messages and notices ride the next reply; idle and signal keep their values).
 */
export class LoopHookCallEndedError extends Error {
	override readonly name = "LoopHookCallEndedError";
	/** The member that was read, e.g. `sessionManager.getSessionId`. */
	readonly member: string;
	constructor(member: string) {
		super(`this loop-hook call has ended; ${member} is bound to that call only`);
		this.member = member;
	}
}

export function readOnlySession(
	sessionId: string,
	cwd: string,
	live: () => boolean,
	session: { readonly carried: CarriedSession | undefined; readonly sessionDir: string | undefined },
): ReadonlySessionManager {
	const { carried, sessionDir } = session;
	const bound =
		<T>(member: string, read: () => T) =>
		(): T => {
			if (!live()) throw new LoopHookCallEndedError(`sessionManager.${member}`);
			return read();
		};
	const header = carried?.header;
	const unbound = (member: string) => (): never => {
		throw new Error(
			`sessionManager.${member} is loop-side: a loop-hook call on a hand carries only the session's id`,
		);
	};
	return Object.freeze({
		getSessionId: bound("getSessionId", () => sessionId),
		// With carried documents the call's session has a directory here, and so a file in it (never written): extensions
		// that key their stores by a persisted session's directory (goal, /loop) then keep them with the session's documents.
		getSessionFile: bound("getSessionFile", (): string | undefined =>
			sessionDir === undefined ? undefined : join(sessionDir, `${sessionId}.jsonl`),
		),
		getCwd: bound("getCwd", () => cwd),
		// The session's documents, when the loop carried them; otherwise the session has no directory here (as in memory).
		getSessionDir: carried === undefined ? unbound("getSessionDir") : bound("getSessionDir", () => sessionDir ?? ""),
		getLeafId: carried === undefined ? unbound("getLeafId") : bound("getLeafId", () => carried.leafId),
		getLeafEntry: unbound("getLeafEntry"),
		getEntry: unbound("getEntry"),
		getLabel: unbound("getLabel"),
		getBranch:
			carried === undefined
				? unbound("getBranch")
				: bound("getBranch", () => [...(carried.branch ?? carried.handEntries)]),
		getFullBranch: unbound("getFullBranch"),
		buildContextEntries: unbound("buildContextEntries"),
		buildSessionContext: unbound("buildSessionContext"),
		buildSessionProjection: unbound("buildSessionProjection"),
		getHeader: header === undefined ? unbound("getHeader") : bound("getHeader", () => ({ ...header })),
		getEntries:
			carried === undefined
				? unbound("getEntries")
				: bound("getEntries", () => [...(carried.branch ?? carried.handEntries)]),
		reduceHistory:
			carried === undefined
				? unbound("reduceHistory")
				: <T>(reducer: HistoryReducer<T>): T =>
						bound("reduceHistory", () => carried.handEntries.reduce(reducer.add, reducer.initial()))(),
		getTree: unbound("getTree"),
		getSessionName: unbound("getSessionName"),
	});
}
